import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJson, runCli, runCliError, runCliFailure, transition } from '../helpers/cli.js';
import { cleanupTemporaryState, commitFiles, git, makeRepo, makeTempDir, startSession } from '../helpers/session.js';
import { countRows, stateDbPath, withStateDb } from '../helpers/state-db.js';
import { appendEntryToSession, createId } from '../../src/adapters/fs/sqlite-store.js';
import { createThreadloopProgram } from '../../src/cli-program.js';
import { buildProtocolContract } from '../../src/contracts/protocol.js';

async function readArtifact(repoDir: string, name: string) {
  return readFile(path.join(repoDir, `.threadloop/artifacts/${name}`), 'utf8');
}

async function readExcludeFile(repoDir: string) {
  return readFile(path.join(repoDir, '.git/info/exclude'), 'utf8');
}

async function startSessionId(repoDir: string, title: string, extraArgs: string[] = []) {
  return (await startSession(repoDir, title, extraArgs)).session_id;
}

async function sessionStatus<T>(repoDir: string, sessionId: string) {
  return parseJson<{ ok: true; command: string; data: T }>(
    (await runCli(repoDir, ['session', 'status', '--session', sessionId, '--json'])).stdout,
  );
}

function readStoredRepoSnapshot(repoDir: string, sessionId: string) {
  const row = withStateDb(
    repoDir,
    (db) =>
      db.prepare(`SELECT base_ref, changed_files_json FROM repo_snapshots WHERE session_id = ?`).get(sessionId) as
        { base_ref: string | null; changed_files_json: string } | undefined,
  );
  return row ? { baseRef: row.base_ref, changedFiles: JSON.parse(row.changed_files_json) as string[] } : null;
}

async function runConcurrentMutationBurst(repoDir: string, sessionId: string, label: string) {
  const captureBodies = Array.from({ length: 8 }, (_, index) => `${label} capture ${index + 1}`);
  const agentBodies = Array.from({ length: 4 }, (_, index) => `${label} agent capture ${index + 1}`);
  const heartbeatSources = ['cli', 'daemon', 'reconcile', 'daemon'] as const;

  await Promise.all([
    ...captureBodies.map((body, index) =>
      runCli(repoDir, [
        'session',
        'capture',
        index % 2 === 0 ? 'note' : 'decision',
        body,
        '--session',
        sessionId,
        '--json',
      ]),
    ),
    ...agentBodies.map((body) =>
      appendEntryToSession(repoDir, sessionId, {
        id: createId('entry'),
        kind: 'note',
        body,
        metadata: { mode: 'agent' },
        createdAt: new Date().toISOString(),
        source: 'agent',
      }),
    ),
    ...heartbeatSources.map((source) =>
      runCli(repoDir, ['session', 'heartbeat', '--session', sessionId, '--source', source, '--json']),
    ),
    ...Array.from({ length: 4 }, () => runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json'])),
  ]);

  const status = await sessionStatus<{
    session: { last_heartbeat_at: string | null; last_heartbeat_source: string | null };
    entries: { count: number; kinds: Record<string, number> };
  }>(repoDir, sessionId);

  expect(status.data.entries.count).toBe(1 + captureBodies.length + agentBodies.length);
  expect(status.data.entries.kinds.intent).toBe(1);
  expect(status.data.entries.kinds.note).toBe(4 + agentBodies.length);
  expect(status.data.entries.kinds.decision).toBe(4);
  expect(status.data.session.last_heartbeat_at).toBeTruthy();
  expect(['cli', 'daemon', 'reconcile']).toContain(status.data.session.last_heartbeat_source);

  const entries = withStateDb(
    repoDir,
    (db) =>
      db.prepare(`SELECT body, source FROM entries WHERE session_id = ? ORDER BY rowid`).all(sessionId) as Array<{
        body: string;
        source: string;
      }>,
  );
  const bodies = entries.map((entry) => entry.body);

  expect(bodies).toContain(`Task started: ${label}`);
  expect(bodies.filter((body) => captureBodies.includes(body))).toHaveLength(captureBodies.length);
  expect(new Set(bodies.filter((body) => captureBodies.includes(body)))).toEqual(new Set(captureBodies));
  expect(bodies.filter((body) => agentBodies.includes(body))).toHaveLength(agentBodies.length);
  expect(new Set(bodies.filter((body) => agentBodies.includes(body)))).toEqual(new Set(agentBodies));
  expect(entries.filter((entry) => agentBodies.includes(entry.body)).every((entry) => entry.source === 'agent')).toBe(
    true,
  );
  expect(countRows(repoDir, 'repo_snapshots', 'session_id = ?', sessionId)).toBe(1);
}

describe('threadloop CLI', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeRepo();
  });

  afterEach(cleanupTemporaryState);

  it('initializes, starts, captures, reconciles, transitions, and generates an artifact on SQLite state', async () => {
    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const value = 1;\n', 'utf8');
    const sessionId = await startSessionId(repoDir, 'Add retry logic');
    await runCli(repoDir, [
      'session',
      'capture',
      'decision',
      'Retry only idempotent jobs',
      '--because',
      'Non-idempotent replay is unsafe',
      '--session',
      sessionId,
    ]);
    await runCli(repoDir, [
      'session',
      'capture',
      'validation',
      'Verified stored snapshot refresh',
      '--session',
      sessionId,
    ]);
    await runCli(repoDir, ['session', 'heartbeat', '--session', sessionId, '--source', 'daemon', '--json']);
    await runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json']);
    await runCli(repoDir, ['artifact', 'generate']);

    const artifact = await readArtifact(repoDir, 'add-retry-logic.change-brief.md');
    expect(artifact).toContain('# Add retry logic');
    expect(artifact).toContain('Retry only idempotent jobs');
    expect(artifact).toContain('feature.ts');
    expect(artifact).not.toContain('.threadloop/');

    expect(existsSync(stateDbPath(repoDir))).toBe(true);
    expect(withStateDb(repoDir, (db) => db.prepare(`SELECT status FROM tasks`).all())).toEqual([{ status: 'queued' }]);
    const status = await sessionStatus<{
      session: { ended_at: string | null; last_heartbeat_source: string | null };
      entries: { count: number; kinds: Record<string, number> };
      repo_snapshot: { changedFiles: string[] } | null;
    }>(repoDir, sessionId);
    expect(status.data.entries).toEqual({ count: 3, kinds: { intent: 1, decision: 1, validation: 1 } });
    expect(status.data.session).toMatchObject({ ended_at: null, last_heartbeat_source: 'daemon' });
    expect(status.data.repo_snapshot?.changedFiles).toContain('feature.ts');

    expect((await transition(repoDir, sessionId, 'framed', 0, 'v2-flow:framed')).data.session_id).toBe(sessionId);
    const listed = parseJson<{
      data: { sessions: Array<{ session_id: string; active: boolean; ended_at: string | null }> };
    }>((await runCli(repoDir, ['session', 'list', '--json'])).stdout);
    expect(listed.data.sessions).toMatchObject([{ session_id: sessionId, active: true, ended_at: null }]);
  });

  it('auto-initializes on session start and records initial actor and issue metadata', async () => {
    const started = parseJson<{ data: { session_id: string; task: { id: string; issueRef: string | null } } }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Bootstrap task',
          '--goal',
          'Allow zero-touch agent startup',
          '--issue',
          'ISSUE-42',
          '--actor',
          'agent',
          '--json',
        ])
      ).stdout,
    );

    expect(started.data.task.issueRef).toBe('ISSUE-42');
    expect(existsSync(path.join(repoDir, '.threadloop/config.json'))).toBe(true);
    expect(existsSync(stateDbPath(repoDir))).toBe(true);
    expect(existsSync(path.join(repoDir, '.gitignore'))).toBe(false);
    expect(await readExcludeFile(repoDir)).toContain('.threadloop/state/');

    withStateDb(repoDir, (db) => {
      expect(db.prepare(`SELECT issue_ref FROM tasks WHERE id = ?`).get(started.data.task.id)).toEqual({
        issue_ref: 'ISSUE-42',
      });
      expect(
        db.prepare(`SELECT kind, source FROM entries WHERE session_id = ? ORDER BY rowid`).get(started.data.session_id),
      ).toEqual({ kind: 'intent', source: 'agent' });
    });
    expect(countRows(repoDir, 'repo_snapshots', 'session_id = ?', started.data.session_id)).toBe(1);
  });

  it('defaults an omitted session base to main when the ref exists', async () => {
    await git(repoDir, 'commit', '--allow-empty', '-m', 'main baseline');
    await git(repoDir, 'branch', '-M', 'main');
    await git(repoDir, 'switch', '-c', 'threadloop/default-base');

    const started = parseJson<{ data: { session_id: string; session: { baseRef: string | null } } }>(
      (await runCli(repoDir, ['session', 'start', 'Default base task', '--goal', 'Match the workflow', '--json']))
        .stdout,
    );

    expect(started.data.session.baseRef).toBe('main');
    expect(readStoredRepoSnapshot(repoDir, started.data.session_id)?.baseRef).toBe('main');
  });

  it('rejects a newer schema before changing journal mode or bootstrapping tables', async () => {
    await mkdir(path.join(repoDir, '.threadloop/state'), { recursive: true });
    await writeFile(
      path.join(repoDir, '.threadloop/config.json'),
      `${JSON.stringify({ version: 1, createdAt: '2026-07-23T12:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    );
    const journalMode = () => withStateDb(repoDir, (db) => db.prepare(`PRAGMA journal_mode`).get());
    withStateDb(
      repoDir,
      (db) => {
        db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
        db.prepare(`INSERT INTO metadata (key, value) VALUES ('schema_version', '9')`).run();
      },
      { readOnly: false },
    );
    expect(journalMode()).toEqual({ journal_mode: 'delete' });

    expect((await runCliFailure(repoDir, ['session', 'list'])).stderr).toContain(
      'Unsupported ThreadLoop schema version: 9',
    );

    expect(
      withStateDb(repoDir, (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()),
    ).toEqual([{ name: 'metadata' }]);
    expect(journalMode()).toEqual({ journal_mode: 'delete' });
  });

  it('reports malformed config JSON with the ThreadLoop error message', async () => {
    await mkdir(path.join(repoDir, '.threadloop/state'), { recursive: true });
    await writeFile(path.join(repoDir, '.threadloop/config.json'), '{not-json\n', 'utf8');

    expect((await runCliFailure(repoDir, ['session', 'list'])).stderr).toContain('Invalid .threadloop/config.json');
  });

  it('reports malformed SQLite JSON columns with the ThreadLoop error message', async () => {
    await runCli(repoDir, ['init']);
    await startSession(repoDir, 'Add retry logic');
    withStateDb(repoDir, (db) => db.prepare(`UPDATE tasks SET constraints_json = '{not-json'`).run(), {
      readOnly: false,
    });

    expect((await runCliFailure(repoDir, ['session', 'list'])).stderr).toContain('Invalid .threadloop/state/state.db');
  });

  it('supports capture via $EDITOR and alternate artifact renderers', async () => {
    const editorScript = path.join(repoDir, 'fake-editor.sh');
    await writeFile(
      editorScript,
      '#!/bin/sh\nprintf "Reviewer should inspect retry cancellation path" > "$1"\n',
      'utf8',
    );

    await runCli(repoDir, ['init']);
    const sessionId = await startSessionId(repoDir, 'Add retry logic');
    await runCli(repoDir, ['session', 'capture', 'reviewer_guidance', '--edit', '--session', sessionId], {
      EDITOR: `sh ${editorScript}`,
    });
    await runCli(repoDir, ['artifact', 'generate', 'pr-summary']);
    await runCli(repoDir, ['artifact', 'generate', 'handoff']);

    const prSummary = await readArtifact(repoDir, 'add-retry-logic.pr-summary.md');
    expect(prSummary).toContain('# PR Summary: Add retry logic');
    expect(prSummary).toContain('Reviewer should inspect retry cancellation path');
    const handoff = await readArtifact(repoDir, 'add-retry-logic.handoff.md');
    expect(handoff).toContain('contract_version: 3');
    // The handoff v3 contract sections, in order, among whatever narrative sections surround them.
    const contractSections = [
      '# Handoff: Add retry logic',
      '## Lifecycle history',
      '## Proof and freshness',
      '## Review findings',
      '## Repair budget',
      '## Human approval and merge',
      '## Audit evidence',
      '## Next human action',
    ];
    expect(handoff.match(/^#{1,2} .+$/gm)?.filter((heading) => contractSections.includes(heading))).toEqual(
      contractSections,
    );
  });

  it('renders branch, base ref, issue ref, and closing reference in pr-summary artifacts', async () => {
    await commitFiles(repoDir, 'base commit', { 'base.txt': 'base\n' });
    await git(repoDir, 'branch', '-M', 'main');
    const sessionId = await startSessionId(repoDir, 'Prepare PR summary', ['--base', 'main', '--issue', 'ISSUE-18']);

    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = 18;\n', 'utf8');
    await runCli(repoDir, ['session', 'capture', 'decision', 'Keep the summary PR-ready', '--session', sessionId]);
    await runCli(repoDir, ['artifact', 'generate', 'pr-summary', '--session', sessionId, '--json']);

    const prSummary = await readArtifact(repoDir, 'prepare-pr-summary.pr-summary.md');
    expect(prSummary).toContain('issue_ref: ISSUE-18');
    expect(prSummary).toContain('## PR metadata');
    expect(prSummary).toContain('- Branch: main');
    expect(prSummary).toContain('- Base ref: main');
    expect(prSummary).toContain('- Issue: ISSUE-18');
    expect(prSummary).toContain('- Closing reference: Closes ISSUE-18');
  });

  it('uses a live snapshot when generating an artifact for an active session', async () => {
    const sessionId = await startSessionId(repoDir, 'Live snapshot artifact');
    await writeFile(path.join(repoDir, 'active-change.ts'), 'export const activeChange = true;\n', 'utf8');

    const artifact = parseJson<{ data: { artifact: { snapshotSource: string } } }>(
      (await runCli(repoDir, ['artifact', 'generate', '--session', sessionId, '--json'])).stdout,
    );

    expect(artifact.data.artifact.snapshotSource).toBe('live');
    expect(readStoredRepoSnapshot(repoDir, sessionId)?.changedFiles).toContain('active-change.ts');
    expect(await readArtifact(repoDir, 'live-snapshot-artifact.change-brief.md')).toContain('active-change.ts');
  });

  it('creates .git/info/exclude on init when missing', async () => {
    await rm(path.join(repoDir, '.git/info/exclude'));
    const result = await runCli(repoDir, ['init']);
    const exclude = await readExcludeFile(repoDir);

    expect(result.stdout).toContain('Initialized ThreadLoop');
    expect(result.stdout).toContain('Created .git/info/exclude and added ThreadLoop state and receipt exclusions');
    expect(exclude).toContain('.threadloop/state/');
    expect(exclude).toContain('.threadloop/artifacts/receipts/');
  });

  it('updates existing .git/info/exclude without duplicating the state entry', async () => {
    await writeFile(path.join(repoDir, '.git/info/exclude'), '*.log\n', 'utf8');

    const first = await runCli(repoDir, ['init']);
    const second = await runCli(repoDir, ['init']);
    const exclude = await readExcludeFile(repoDir);

    expect(first.stdout).toContain('Updated .git/info/exclude to ignore ThreadLoop state and local receipts');
    expect(second.stdout).toContain('.git/info/exclude already ignores ThreadLoop state and local receipts');
    expect(exclude.match(/\.threadloop\/state\//g)?.length).toBe(1);
    expect(exclude.match(/\.threadloop\/artifacts\/receipts\//g)?.length).toBe(1);
  });

  it('leaves tracked .gitignore unchanged and uses .git/info/exclude for ThreadLoop state', async () => {
    await writeFile(path.join(repoDir, '.gitignore'), 'node_modules/\n', 'utf8');

    const result = await runCli(repoDir, ['init']);
    const exclude = await readExcludeFile(repoDir);

    expect(result.stdout).toContain('.git/info/exclude');
    expect(await readFile(path.join(repoDir, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(exclude).toContain('.threadloop/state/');
    expect(exclude).toContain('.threadloop/artifacts/receipts/');
  });

  it('filters ThreadLoop-owned paths from artifact scope without a base ref', async () => {
    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = true;\n', 'utf8');
    const sessionId = await startSessionId(repoDir, 'Track feature work');
    await runCli(repoDir, [
      'session',
      'capture',
      'note',
      'Only repo files should appear in scope',
      '--session',
      sessionId,
    ]);
    await runCli(repoDir, ['artifact', 'generate']);

    const artifact = await readArtifact(repoDir, 'track-feature-work.change-brief.md');
    expect(artifact).toContain('feature.ts');
    expect(artifact).not.toContain('.threadloop/config.json');
    expect(artifact).not.toContain('.threadloop/state/state.json');
    expect(artifact).not.toContain('.threadloop/state/state.db');
    expect(artifact).not.toContain('.threadloop/artifacts/');
  });

  it('filters ThreadLoop-owned paths from artifact scope with a base ref', async () => {
    await commitFiles(repoDir, 'base commit', { 'base.txt': 'base\n' });
    await git(repoDir, 'branch', '-M', 'main');
    await git(repoDir, 'checkout', '-b', 'feature/threadloop');
    await runCli(repoDir, ['init']);
    await commitFiles(repoDir, 'feature commit', { 'feature.ts': 'export const feature = 2;\n' });

    await startSession(repoDir, 'Base-aware scope', ['--base', 'main']);
    await runCli(repoDir, ['artifact', 'generate']);

    const artifact = await readArtifact(repoDir, 'base-aware-scope.change-brief.md');
    expect(artifact).toContain('feature.ts');
    expect(artifact).not.toContain('.threadloop/');
  });

  it('fails cleanly for a missing base ref', async () => {
    await runCli(repoDir, ['init']);
    expect(
      (
        await runCliError(repoDir, [
          'session',
          'start',
          'Add retry logic',
          '--goal',
          'x',
          '--base',
          'missing-branch',
          '--json',
        ])
      ).error.code,
    ).toBe('BASE_REF_NOT_FOUND');
  });

  it('targets sessions explicitly with json envelopes and refuses to guess when several are active', async () => {
    await runCli(repoDir, ['init']);
    const first = await startSessionId(repoDir, 'First task');
    const second = await startSessionId(repoDir, 'Second task');

    expect((await runCliError(repoDir, ['artifact', 'generate', '--json'])).error.code).toBe('SESSION_AMBIGUOUS');

    const captured = parseJson(
      (
        await runCli(repoDir, [
          'session',
          'capture',
          'decision',
          'Target the first session explicitly',
          '--session',
          first,
          '--json',
        ])
      ).stdout,
    );
    expect(captured).toMatchObject({
      ok: true,
      command: 'session capture',
      data: { session_id: first, entry: { kind: 'decision', body: 'Target the first session explicitly' } },
    });

    expect(await sessionStatus(repoDir, first)).toMatchObject({
      ok: true,
      command: 'session status',
      data: { session_id: first, entries: { count: 2, kinds: { intent: 1, decision: 1 } } },
    });

    const artifact = parseJson<{ data: { artifact: { path: string } } }>(
      (await runCli(repoDir, ['artifact', 'generate', '--session', first, '--json'])).stdout,
    );
    expect(artifact).toMatchObject({
      ok: true,
      command: 'artifact generate',
      data: { session_id: first, artifact: { kind: 'change-brief' } },
    });
    expect(artifact.data.artifact.path).toContain('first-task.change-brief.md');

    expect((await runCli(repoDir, ['session', 'status', '--session', second])).stdout).toContain(`Session: ${second}`);
    const listed = parseJson<{ data: { sessions: Array<{ session_id: string; active: boolean }> } }>(
      (await runCli(repoDir, ['session', 'list', '--json'])).stdout,
    );
    expect(new Set(listed.data.sessions.map(({ session_id, active }) => `${session_id}:${active}`))).toEqual(
      new Set([`${first}:true`, `${second}:true`]),
    );
  });

  it('fails cleanly outside a git repository', async () => {
    expect((await runCliFailure(await makeTempDir('threadloop-no-git-'), ['init'])).stderr).toContain(
      'threadloop [NOT_GIT_REPOSITORY]: ThreadLoop requires a Git repository.',
    );
  });

  it('supports explicit session commands and stable json envelopes', async () => {
    await runCli(repoDir, ['init']);

    const started = parseJson<{ data: { session_id: string } }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Explicit task',
          '--goal',
          'Track the explicit session',
          '--issue',
          'ISSUE-7',
          '--actor',
          'agent',
          '--json',
        ])
      ).stdout,
    );
    const sessionId = started.data.session_id;
    expect(started).toMatchObject({ ok: true, command: 'session start', data: { task: { issueRef: 'ISSUE-7' } } });

    expect(parseJson((await runCli(repoDir, ['session', 'list', '--json'])).stdout)).toMatchObject({
      ok: true,
      command: 'session list',
      data: { sessions: [{ session_id: sessionId, active: true }] },
    });

    const captured = parseJson(
      (
        await runCli(repoDir, [
          'session',
          'capture',
          'decision',
          'Keep the explicit contract',
          '--session',
          sessionId,
          '--because',
          'Machine consumers need a stable envelope',
          '--actor',
          'agent',
          '--json',
        ])
      ).stdout,
    );
    expect(captured).toMatchObject({
      ok: true,
      command: 'session capture',
      data: {
        session_id: sessionId,
        entry: { kind: 'decision', body: 'Keep the explicit contract', source: 'agent' },
      },
    });

    const heartbeat = parseJson<{ data: { session: { last_heartbeat_at: string | null } } }>(
      (await runCli(repoDir, ['session', 'heartbeat', '--session', sessionId, '--source', 'cli', '--json'])).stdout,
    );
    expect(heartbeat).toMatchObject({
      ok: true,
      command: 'session heartbeat',
      data: { session_id: sessionId, session: { last_heartbeat_source: 'cli' } },
    });
    expect(heartbeat.data.session.last_heartbeat_at).toBeTruthy();

    expect(await sessionStatus(repoDir, sessionId)).toMatchObject({
      ok: true,
      command: 'session status',
      data: {
        session_id: sessionId,
        entries: { count: 2, kinds: { intent: 1, decision: 1 } },
        task: { issue_ref: 'ISSUE-7' },
      },
    });

    expect(
      parseJson((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout),
    ).toMatchObject({
      ok: true,
      command: 'session next',
      data: { candidate: { target_state: 'framed', executable: true } },
    });

    const transitioned = await runCli(repoDir, [
      'session',
      'transition',
      'framed',
      '--session',
      sessionId,
      '--expected-state-version',
      '0',
      '--idempotency-key',
      'explicit-flow:framed',
      '--actor',
      'cli',
      '--input',
      '{}',
      '--json',
    ]);
    expect(parseJson(transitioned.stdout)).toMatchObject({
      ok: true,
      command: 'session transition',
      data: { lifecycle: { state: 'framed', state_version: 1 } },
    });

    expect(await sessionStatus(repoDir, sessionId)).toMatchObject({ data: { session: { ended_at: null } } });
  });

  it('renders actionable text and json errors when a session id is required', async () => {
    await runCli(repoDir, ['init']);

    expect(await runCliError(repoDir, ['session', 'status', '--json'])).toMatchObject({
      ok: false,
      command: 'session status',
      error: { code: 'SESSION_REQUIRED' },
    });
    for (const args of [
      ['session', 'status'],
      ['session', 'capture', 'note', 'Need a session first'],
    ]) {
      const failure = await runCliFailure(repoDir, args);
      expect(failure.stderr).toContain('threadloop [SESSION_REQUIRED]: A session id is required for this command.');
      expect(failure.stderr).toContain('Hint: Pass --session <id>.');
    }
  });

  it('names the output path when audit export receives an empty output value', async () => {
    const failure = await runCliFailure(repoDir, ['audit', 'export', '--session', 'session_123', '--output', '']);

    expect(failure.stderr).toContain('Output path must be non-empty.');
    expect(failure.stderr).not.toContain('Session id must be non-empty.');
  });

  it.each([[[]], [['session']]])('fails with usage on stderr when %j names no runnable command', async (args) => {
    const failure = await runCliFailure(repoDir, args);

    expect((failure as Error & { code?: number }).code).toBe(1);
    expect(failure.stderr).toContain('Usage:');
  });

  it('rejects reconcile when both --session and --all are given', async () => {
    const sessionId = await startSessionId(repoDir, 'Reconcile target');

    expect(
      (await runCliError(repoDir, ['session', 'reconcile', '--session', sessionId, '--all', '--json'])).error,
    ).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'Pass either --session <id> or --all, not both.',
    });
  });

  it('renders current command families in help output and rejects removed commands', async () => {
    const rootHelp = await runCli(repoDir, ['--help']);
    expect(rootHelp.stdout).toContain('session');
    expect(rootHelp.stdout).toContain('artifact');
    expect(rootHelp.stdout).not.toMatch(/^\s+(start|status|capture|daemon)\b/m);
    expect(rootHelp.stderr).toBe('');

    const sessionHelp = await runCli(repoDir, ['session', '--help']);
    for (const command of ['start', 'list', 'status', 'capture', 'heartbeat', 'reconcile', 'transition', 'next']) {
      expect(sessionHelp.stdout).toMatch(new RegExp(`^\\s+${command}\\b`, 'm'));
    }
    expect(sessionHelp.stdout).not.toContain('finish');

    const artifactHelp = await runCli(repoDir, ['artifact', 'generate', '--help']);
    expect(artifactHelp.stdout).toContain('--session <id>');
    expect(artifactHelp.stderr).toBe('');

    // No functional test passes --constraint or relies on the documented base default, so pin them here.
    const startHelp = await runCli(repoDir, ['session', 'start', '--help']);
    for (const usage of ['--goal <goal>', '--constraint <constraint...>', 'main when available', '--issue <ref>']) {
      expect(startHelp.stdout).toContain(usage);
    }

    expect((await runCliError(repoDir, ['finish', '--json'])).error.code).toBe('INVALID_ARGUMENT');
    expect((await runCliError(repoDir, ['session', 'finish', '--json'])).error.code).toBe('INVALID_ARGUMENT');
  });

  it('renders a derived protocol contract in json mode', async () => {
    const protocol = parseJson<{ ok: true; command: string; data: ReturnType<typeof buildProtocolContract> }>(
      (await runCli(repoDir, ['protocol', '--json'])).stdout,
    );

    expect(protocol).toMatchObject({ ok: true, command: 'protocol' });
    expect(protocol.data).toEqual(buildProtocolContract(createThreadloopProgram()));
    // Content the unit protocol-contract test does not already pin.
    expect(protocol.data.envVars).toEqual({ EDITOR: 'Editor command used by --edit and --goal-edit flows.' });
    expect(protocol.data.captureKinds).toEqual([
      'intent',
      'note',
      'decision',
      'risk',
      'constraint',
      'validation',
      'reviewer_guidance',
    ]);
    expect(protocol.data.artifactKinds).toEqual(['change-brief', 'pr-summary', 'handoff']);
    expect(protocol.data.commands['artifact generate']).toContain(
      'threadloop artifact generate [kind] [--session <id>] [--json]',
    );
    expect(protocol.data.commands['session capture']).toContain(
      'threadloop session capture <kind> [text] --session <id> [--because <reason>] [--actor <actor>] [--edit] [--json]',
    );
    expect(protocol.data.commands['session transition']).toContain(
      'threadloop session transition <target-state> --session <id> --expected-state-version <version> --idempotency-key <key> --actor <actor> --input <json-object> [--json]',
    );
    expect(protocol.data.commands['session next']).toContain('threadloop session next --session <id> [--json]');
    expect(protocol.data.commands.init).toBe('threadloop init - Initialize ThreadLoop in the current Git repo');
    expect(protocol.data.notes).not.toContain('Use --json flag for machine-readable output on any command');
  });

  it('reconciles a specific session and persists the snapshot', async () => {
    await runCli(repoDir, ['init']);
    const sessionId = await startSessionId(repoDir, 'Reconcile test');

    expect(
      parseJson((await runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json'])).stdout),
    ).toMatchObject({
      ok: true,
      command: 'session reconcile',
      data: { reconciled: 1, sessions: [{ session_id: sessionId }] },
    });

    const reReconcile = parseJson<{ data: { sessions: Array<{ previous_head_sha: string | null }> } }>(
      (await runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json'])).stdout,
    );
    expect(reReconcile.data.sessions[0]?.previous_head_sha).toBeTruthy();
  });

  it('reconciles all active sessions with --all', async () => {
    await runCli(repoDir, ['init']);
    await startSession(repoDir, 'First task');
    await startSession(repoDir, 'Second task');

    expect(parseJson((await runCli(repoDir, ['session', 'reconcile', '--all', '--json'])).stdout)).toMatchObject({
      data: { reconciled: 2 },
    });
  });

  it('reconcile fails without --session or --all', async () => {
    await runCli(repoDir, ['init']);
    await startSession(repoDir, 'Test task');

    expect((await runCliError(repoDir, ['session', 'reconcile', '--json'])).error.code).toBe(
      'RECONCILE_TARGET_REQUIRED',
    );
  });

  it('reconcile does not create semantic entries', async () => {
    await runCli(repoDir, ['init']);
    const sessionId = await startSessionId(repoDir, 'Entry test');

    await runCli(repoDir, ['session', 'capture', 'decision', 'Pre-reconcile decision', '--session', sessionId]);
    await runCli(repoDir, ['session', 'reconcile', '--session', sessionId]);
    await runCli(repoDir, ['session', 'capture', 'decision', 'Post-reconcile decision', '--session', sessionId]);

    expect(
      (await sessionStatus<{ entries: { kinds: Record<string, number> } }>(repoDir, sessionId)).data.entries.kinds,
    ).toEqual({ intent: 1, decision: 2 });
  });

  it('keeps SQLite-backed state intact across repeated concurrent mutation bursts', async () => {
    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = true;\n', 'utf8');

    const roundCount = 2;
    for (let round = 0; round < roundCount; round += 1) {
      const label = `Concurrent flow ${round + 1}`;
      await runConcurrentMutationBurst(repoDir, await startSessionId(repoDir, label), label);
    }

    expect(countRows(repoDir, 'sessions')).toBe(roundCount);
    expect(countRows(repoDir, 'repo_snapshots')).toBe(roundCount);
    expect(countRows(repoDir, 'active_sessions')).toBe(roundCount);
  });
});
