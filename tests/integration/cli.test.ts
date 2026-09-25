import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, runCliFailure } from '../helpers/cli.js';
import { appendEntryToSession, closeSqliteConnections, createId } from '../../src/adapters/fs/sqlite-store.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { createThreadloopProgram } from '../../src/cli-program.js';
import { buildProtocolContract } from '../../src/contracts/protocol.js';

const execFileAsync = promisify(execFile);

async function readArtifact(repoDir: string, name: string) {
  return readFile(path.join(repoDir, `.threadloop/artifacts/${name}`), 'utf8');
}

async function readExcludeFile(repoDir: string) {
  return readFile(path.join(repoDir, '.git/info/exclude'), 'utf8');
}

async function startSession(repoDir: string, args: string[]) {
  const started = parseJsonOutput<{ data: { session_id: string } }>(
    (await runCli(repoDir, ['session', 'start', ...args, '--json'])).stdout,
  );
  return started.data.session_id;
}

function parseJsonOutput<T>(output: string) {
  return JSON.parse(output) as T;
}

function readStateSnapshot(repoDir: string) {
  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });

  try {
    return {
      taskStatuses: db
        .prepare('SELECT status FROM tasks ORDER BY rowid')
        .all()
        .map((row) => String(row.status)),
      entryKinds: db
        .prepare('SELECT kind FROM entries ORDER BY rowid')
        .all()
        .map((row) => String(row.kind)),
      entryBodies: db
        .prepare('SELECT body FROM entries ORDER BY rowid')
        .all()
        .map((row) => String(row.body)),
    };
  } finally {
    db.close();
  }
}

function readStoredRepoSnapshot(repoDir: string, sessionId: string) {
  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });

  try {
    const row = db
      .prepare(
        `
          SELECT branch, base_ref, changed_files_json
          FROM repo_snapshots
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as { branch: string; base_ref: string | null; changed_files_json: string } | undefined;

    return row
      ? {
          branch: row.branch,
          baseRef: row.base_ref,
          changedFiles: JSON.parse(row.changed_files_json) as string[],
        }
      : null;
  } finally {
    db.close();
  }
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

  const status = parseJsonOutput<{
    data: {
      session: { last_heartbeat_at: string | null; last_heartbeat_source: string | null };
      entries: { count: number; kinds: Record<string, number> };
    };
  }>((await runCli(repoDir, ['session', 'status', '--session', sessionId, '--json'])).stdout);

  expect(status.data.entries.count).toBe(1 + captureBodies.length + agentBodies.length);
  expect(status.data.entries.kinds.intent).toBe(1);
  expect(status.data.entries.kinds.note).toBe(4 + agentBodies.length);
  expect(status.data.entries.kinds.decision).toBe(4);
  expect(status.data.session.last_heartbeat_at).toBeTruthy();
  expect(['cli', 'daemon', 'reconcile']).toContain(status.data.session.last_heartbeat_source);

  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
  try {
    const entries = db
      .prepare(`SELECT body, source FROM entries WHERE session_id = ? ORDER BY rowid`)
      .all(sessionId) as Array<{
      body: string;
      source: string;
    }>;
    const snapshotCount = readParameterizedCount(
      db,
      `SELECT COUNT(*) AS count FROM repo_snapshots WHERE session_id = ?`,
      sessionId,
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
    expect(snapshotCount).toBe(1);
  } finally {
    db.close();
  }
}

describe('threadloop CLI', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-'));
    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  });

  afterEach(async () => {
    closeSqliteConnections();
    await rm(repoDir, { recursive: true, force: true });
  });

  it('initializes, starts, captures, and generates an artifact', async () => {
    await runCli(repoDir, ['init']);
    const sessionId = await startSession(repoDir, ['Add retry logic', '--goal', 'Reduce transient failures']);
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
    await runCli(repoDir, ['artifact', 'generate']);

    const artifact = await readArtifact(repoDir, 'add-retry-logic.change-brief.md');
    expect(artifact).toContain('# Add retry logic');
    expect(artifact).toContain('Retry only idempotent jobs');

    expect(existsSync(path.join(repoDir, '.threadloop/state/state.db'))).toBe(true);
    const snapshot = readStateSnapshot(repoDir);
    expect(snapshot.taskStatuses).toContain('queued');
    expect(snapshot.entryKinds).toContain('decision');
  });

  it('auto-initializes on session start and records initial actor and issue metadata', async () => {
    const started = parseJsonOutput<{
      data: {
        session_id: string;
        task: { id: string; issueRef: string | null };
        session: { id: string };
      };
    }>(
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
    expect(existsSync(path.join(repoDir, '.threadloop/state/state.db'))).toBe(true);
    expect(existsSync(path.join(repoDir, '.gitignore'))).toBe(false);

    const exclude = await readExcludeFile(repoDir);
    expect(exclude).toContain('.threadloop/state/');

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      const taskRow = db.prepare(`SELECT issue_ref FROM tasks WHERE id = ?`).get(started.data.task.id) as
        { issue_ref: string | null } | undefined;
      const entries = db
        .prepare(`SELECT kind, source FROM entries WHERE session_id = ? ORDER BY rowid`)
        .all(started.data.session_id) as Array<{
        kind: string;
        source: string;
      }>;
      const snapshotCount = readParameterizedCount(
        db,
        `SELECT COUNT(*) AS count FROM repo_snapshots WHERE session_id = ?`,
        started.data.session_id,
      );

      expect(taskRow?.issue_ref).toBe('ISSUE-42');
      expect(entries[0]).toMatchObject({ kind: 'intent', source: 'agent' });
      expect(snapshotCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('defaults an omitted session base to main when the ref exists', async () => {
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'main baseline'], { cwd: repoDir });
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['switch', '-c', 'threadloop/default-base'], { cwd: repoDir });

    const started = parseJsonOutput<{
      data: {
        session_id: string;
        session: { baseRef: string | null };
      };
    }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Default base task',
          '--goal',
          'Match the published workflow contract',
          '--json',
        ])
      ).stdout,
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

    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      db.prepare(`INSERT INTO metadata (key, value) VALUES ('schema_version', '9')`).run();
      const journalMode = db.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string };
      expect(journalMode.journal_mode).toBe('delete');
    } finally {
      db.close();
    }

    await expect(runCli(repoDir, ['session', 'list'])).rejects.toThrow('Unsupported ThreadLoop schema version: 9');

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tableNames = unchanged
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all()
        .map((row) => String(row.name));
      const journalMode = unchanged.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string };

      expect(tableNames).toEqual(['metadata']);
      expect(journalMode.journal_mode).toBe('delete');
    } finally {
      unchanged.close();
    }
  });

  it('reports malformed config JSON with the ThreadLoop error message', async () => {
    await mkdir(path.join(repoDir, '.threadloop/state'), { recursive: true });
    await writeFile(path.join(repoDir, '.threadloop/config.json'), '{not-json\n', 'utf8');

    await expect(runCli(repoDir, ['session', 'list'])).rejects.toThrow('Invalid .threadloop/config.json');
  });

  it('reports malformed SQLite JSON columns with the ThreadLoop error message', async () => {
    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['session', 'start', 'Add retry logic', '--goal', 'Reduce transient failures']);

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
    db.prepare(`UPDATE tasks SET constraints_json = '{not-json'`).run();
    db.close();

    await expect(runCli(repoDir, ['session', 'list'])).rejects.toThrow('Invalid .threadloop/state/state.db');
  });

  it('supports capture via $EDITOR and alternate artifact renderers', async () => {
    const editorScript = path.join(repoDir, 'fake-editor.sh');
    await writeFile(
      editorScript,
      '#!/bin/sh\nprintf "Reviewer should inspect retry cancellation path" > "$1"\n',
      'utf8',
    );
    await execFileAsync('chmod', ['+x', editorScript], { cwd: repoDir });

    await runCli(repoDir, ['init']);
    const sessionId = await startSession(repoDir, ['Add retry logic', '--goal', 'Reduce transient failures']);
    await runCli(repoDir, ['session', 'capture', 'reviewer_guidance', '--edit', '--session', sessionId], {
      EDITOR: `sh ${editorScript}`,
    });
    await runCli(repoDir, ['artifact', 'generate', 'pr-summary']);
    await runCli(repoDir, ['artifact', 'generate', 'handoff']);

    const prSummary = await readArtifact(repoDir, 'add-retry-logic.pr-summary.md');
    const handoff = await readArtifact(repoDir, 'add-retry-logic.handoff.md');

    expect(prSummary).toContain('# PR Summary: Add retry logic');
    expect(prSummary).toContain('Reviewer should inspect retry cancellation path');
    expect(handoff).toContain('# Handoff: Add retry logic');
    expect(handoff).toContain('contract_version: 3');
    expect(handoff).toContain('## Lifecycle history');
    expect(handoff).toContain('## Proof and freshness');
    expect(handoff).toContain('## Review findings');
    expect(handoff).toContain('## Repair budget');
    expect(handoff).toContain('## Human approval and merge');
    expect(handoff).toContain('## Audit evidence');
    expect(handoff).toContain('## Next human action');
  });

  it('renders branch, base ref, issue ref, and closing reference in pr-summary artifacts', async () => {
    await writeFile(path.join(repoDir, 'base.txt'), 'base\n', 'utf8');
    await execFileAsync('git', ['add', 'base.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'base commit'], { cwd: repoDir });
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repoDir });

    const started = parseJsonOutput<{ data: { session_id: string } }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Prepare PR summary',
          '--goal',
          'Render PR metadata',
          '--base',
          'main',
          '--issue',
          'ISSUE-18',
          '--json',
        ])
      ).stdout,
    );

    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = 18;\n', 'utf8');
    await runCli(repoDir, [
      'session',
      'capture',
      'decision',
      'Keep the summary PR-ready',
      '--session',
      started.data.session_id,
      '--json',
    ]);
    await runCli(repoDir, ['artifact', 'generate', 'pr-summary', '--session', started.data.session_id, '--json']);

    const prSummary = await readArtifact(repoDir, 'prepare-pr-summary.pr-summary.md');
    expect(prSummary).toContain('issue_ref: ISSUE-18');
    expect(prSummary).toContain('## PR metadata');
    expect(prSummary).toContain('- Branch: main');
    expect(prSummary).toContain('- Base ref: main');
    expect(prSummary).toContain('- Issue: ISSUE-18');
    expect(prSummary).toContain('- Closing reference: Closes ISSUE-18');
  });

  it('uses a live snapshot when generating an artifact for an active session', async () => {
    const started = parseJsonOutput<{
      data: { session_id: string };
    }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Live snapshot artifact',
          '--goal',
          'Use current repo scope',
          '--json',
        ])
      ).stdout,
    );

    await writeFile(path.join(repoDir, 'active-change.ts'), 'export const activeChange = true;\n', 'utf8');

    const artifact = parseJsonOutput<{
      data: { artifact: { snapshotSource: string } };
    }>((await runCli(repoDir, ['artifact', 'generate', '--session', started.data.session_id, '--json'])).stdout);
    const storedSnapshot = readStoredRepoSnapshot(repoDir, started.data.session_id);
    const renderedArtifact = await readArtifact(repoDir, 'live-snapshot-artifact.change-brief.md');

    expect(artifact.data.artifact.snapshotSource).toBe('live');
    expect(storedSnapshot?.changedFiles).toContain('active-change.ts');
    expect(renderedArtifact).toContain('active-change.ts');
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
    const gitignore = await readFile(path.join(repoDir, '.gitignore'), 'utf8');
    const exclude = await readExcludeFile(repoDir);

    expect(result.stdout).toContain('.git/info/exclude');
    expect(gitignore).toBe('node_modules/\n');
    expect(exclude).toContain('.threadloop/state/');
    expect(exclude).toContain('.threadloop/artifacts/receipts/');
  });

  it('filters ThreadLoop-owned paths from artifact scope without a base ref', async () => {
    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = true;\n', 'utf8');
    const sessionId = await startSession(repoDir, ['Track feature work', '--goal', 'Keep scope clean']);
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
    await writeFile(path.join(repoDir, 'base.txt'), 'base\n', 'utf8');
    await execFileAsync('git', ['add', 'base.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'base commit'], { cwd: repoDir });
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['checkout', '-b', 'feature/threadloop'], { cwd: repoDir });

    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = 2;\n', 'utf8');
    await execFileAsync('git', ['add', 'feature.ts'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'feature commit'], { cwd: repoDir });

    await runCli(repoDir, [
      'session',
      'start',
      'Base-aware scope',
      '--goal',
      'Filter internal paths',
      '--base',
      'main',
    ]);
    await runCli(repoDir, ['artifact', 'generate']);

    const artifact = await readArtifact(repoDir, 'base-aware-scope.change-brief.md');
    expect(artifact).toContain('feature.ts');
    expect(artifact).not.toContain('.threadloop/');
  });

  it('fails cleanly for a missing base ref', async () => {
    await runCli(repoDir, ['init']);
    await expect(
      runCli(repoDir, [
        'session',
        'start',
        'Add retry logic',
        '--goal',
        'Reduce transient failures',
        '--base',
        'missing-branch',
      ]),
    ).rejects.toThrow('BASE_REF_NOT_FOUND');
  });

  it('targets sessions explicitly with json envelopes when several are active', async () => {
    await runCli(repoDir, ['init']);

    const first = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'First task', '--goal', 'Track first task', '--json'])).stdout,
    );
    const second = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Second task', '--goal', 'Track second task', '--json'])).stdout,
    );

    const captured = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; entry: { kind: string; body: string; source: string } };
    }>(
      (
        await runCli(repoDir, [
          'session',
          'capture',
          'decision',
          'Target the first session explicitly',
          '--session',
          first.data.session_id,
          '--json',
        ])
      ).stdout,
    );
    expect(captured).toMatchObject({
      ok: true,
      command: 'session capture',
      data: {
        session_id: first.data.session_id,
        entry: { kind: 'decision', body: 'Target the first session explicitly' },
      },
    });

    const status = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; entries: { count: number; kinds: Record<string, number> } };
    }>((await runCli(repoDir, ['session', 'status', '--session', first.data.session_id, '--json'])).stdout);
    expect(status).toMatchObject({ ok: true, command: 'session status' });
    expect(status.data.session_id).toBe(first.data.session_id);
    expect(status.data.entries.count).toBe(2);
    expect(status.data.entries.kinds.intent).toBe(1);
    expect(status.data.entries.kinds.decision).toBe(1);

    const artifact = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; artifact: { kind: string; path: string } };
    }>((await runCli(repoDir, ['artifact', 'generate', '--session', first.data.session_id, '--json'])).stdout);
    expect(artifact).toMatchObject({
      ok: true,
      command: 'artifact generate',
      data: {
        session_id: first.data.session_id,
        artifact: { kind: 'change-brief' },
      },
    });
    expect(artifact.data.artifact.path).toContain('first-task.change-brief.md');

    const secondStatus = await runCli(repoDir, ['session', 'status', '--session', second.data.session_id]);
    expect(secondStatus.stdout).toContain(`Session: ${second.data.session_id}`);
  });

  it('fails artifact generation without --session when several sessions are active', async () => {
    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['session', 'start', 'First task', '--goal', 'Track first task']);
    await runCli(repoDir, ['session', 'start', 'Second task', '--goal', 'Track second task']);

    const artifactFailure = parseJsonOutput<{ error: { code: string } }>(
      (await runCliFailure(repoDir, ['artifact', 'generate', '--json'])).stderr ?? '',
    );
    expect(artifactFailure.error.code).toBe('SESSION_AMBIGUOUS');
  });

  it('fails cleanly outside a git repository', async () => {
    const nonRepoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-no-git-'));
    await expect(runCli(nonRepoDir, ['init'])).rejects.toThrow();
  });

  it('supports explicit session commands and stable json envelopes', async () => {
    await runCli(repoDir, ['init']);

    const started = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; task_id: string; task: { issueRef: string | null } };
    }>(
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

    expect(started).toMatchObject({ ok: true, command: 'session start' });
    expect(started.data.session_id).toBeTruthy();
    expect(started.data.task.issueRef).toBe('ISSUE-7');

    const listed = parseJsonOutput<{
      ok: true;
      command: string;
      data: { sessions: Array<{ session_id: string; active: boolean }> };
    }>((await runCli(repoDir, ['session', 'list', '--json'])).stdout);
    expect(listed).toMatchObject({ ok: true, command: 'session list' });
    expect(listed.data.sessions).toHaveLength(1);
    expect(listed.data.sessions[0]).toMatchObject({ session_id: started.data.session_id, active: true });

    const captured = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; entry: { kind: string; body: string } };
    }>(
      (
        await runCli(repoDir, [
          'session',
          'capture',
          'decision',
          'Keep the explicit contract',
          '--session',
          started.data.session_id,
          '--because',
          'Machine consumers need a stable envelope',
          '--actor',
          'agent',
          '--json',
        ])
      ).stdout,
    );
    expect(captured).toMatchObject({ ok: true, command: 'session capture' });
    expect(captured.data.session_id).toBe(started.data.session_id);
    expect(captured.data.entry).toMatchObject({
      kind: 'decision',
      body: 'Keep the explicit contract',
      source: 'agent',
    });

    const heartbeat = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; session: { last_heartbeat_at: string | null; last_heartbeat_source: string | null } };
    }>(
      (
        await runCli(repoDir, [
          'session',
          'heartbeat',
          '--session',
          started.data.session_id,
          '--source',
          'cli',
          '--json',
        ])
      ).stdout,
    );
    expect(heartbeat).toMatchObject({ ok: true, command: 'session heartbeat' });
    expect(heartbeat.data.session_id).toBe(started.data.session_id);
    expect(heartbeat.data.session.last_heartbeat_at).toBeTruthy();
    expect(heartbeat.data.session.last_heartbeat_source).toBe('cli');

    const status = parseJsonOutput<{
      ok: true;
      command: string;
      data: {
        session_id: string;
        entries: { count: number; kinds: Record<string, number> };
        session: { ended_at: string | null };
        task: { issue_ref: string | null };
      };
    }>((await runCli(repoDir, ['session', 'status', '--session', started.data.session_id, '--json'])).stdout);
    expect(status).toMatchObject({ ok: true, command: 'session status' });
    expect(status.data.session_id).toBe(started.data.session_id);
    expect(status.data.entries.count).toBe(2);
    expect(status.data.entries.kinds.intent).toBe(1);
    expect(status.data.entries.kinds.decision).toBe(1);
    expect(status.data.task.issue_ref).toBe('ISSUE-7');

    const next = parseJsonOutput<{
      ok: true;
      command: string;
      data: { candidate: { target_state: string; executable: boolean } };
    }>((await runCli(repoDir, ['session', 'next', '--session', started.data.session_id, '--json'])).stdout);
    expect(next).toMatchObject({
      ok: true,
      command: 'session next',
      data: { candidate: { target_state: 'framed', executable: true } },
    });

    const transitioned = parseJsonOutput<{
      ok: true;
      command: string;
      data: { lifecycle: { state: string; state_version: number } };
    }>(
      (
        await runCli(repoDir, [
          'session',
          'transition',
          'framed',
          '--session',
          started.data.session_id,
          '--expected-state-version',
          '0',
          '--idempotency-key',
          'explicit-flow:framed',
          '--actor',
          'cli',
          '--input',
          '{}',
          '--json',
        ])
      ).stdout,
    );
    expect(transitioned).toMatchObject({
      ok: true,
      command: 'session transition',
      data: { lifecycle: { state: 'framed', state_version: 1 } },
    });

    const relisted = parseJsonOutput<{
      ok: true;
      command: string;
      data: { sessions: Array<{ session_id: string; active: boolean; ended_at: string | null }> };
    }>((await runCli(repoDir, ['session', 'list', '--json'])).stdout);
    expect(relisted.data.sessions).toHaveLength(1);
    expect(relisted.data.sessions[0]).toMatchObject({
      session_id: started.data.session_id,
      active: true,
    });
    expect(relisted.data.sessions[0]?.ended_at).toBeNull();

    const finalStatus = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; session: { ended_at: string | null } };
    }>((await runCli(repoDir, ['session', 'status', '--session', started.data.session_id, '--json'])).stdout);
    expect(finalStatus.data.session_id).toBe(started.data.session_id);
    expect(finalStatus.data.session.ended_at).toBeNull();
  });

  it('returns a stable json error when a session id is required', async () => {
    await runCli(repoDir, ['init']);

    try {
      await runCli(repoDir, ['session', 'status', '--json']);
      throw new Error('Expected session status to fail without --session');
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      const parsed = parseJsonOutput<{
        ok: false;
        command: string;
        error: { code: string; message: string };
      }>(failure.stderr ?? '');
      expect(parsed).toMatchObject({
        ok: false,
        command: 'session status',
        error: {
          code: 'SESSION_REQUIRED',
        },
      });
    }
  });

  it('renders actionable text hints for session-required failures', async () => {
    await runCli(repoDir, ['init']);

    const statusFailure = await runCliFailure(repoDir, ['session', 'status']);
    expect(statusFailure.stderr).toContain('threadloop [SESSION_REQUIRED]: A session id is required for this command.');
    expect(statusFailure.stderr).toContain('Hint: Pass --session <id>.');

    const captureFailure = await runCliFailure(repoDir, ['session', 'capture', 'note', 'Need a session first']);
    expect(captureFailure.stderr).toContain(
      'threadloop [SESSION_REQUIRED]: A session id is required for this command.',
    );
    expect(captureFailure.stderr).toContain('Hint: Pass --session <id>.');
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
    const sessionId = await startSession(repoDir, ['Reconcile target', '--goal', 'Pick one target']);

    const failure = parseJsonOutput<{ error: { code: string; message: string } }>(
      (await runCliFailure(repoDir, ['session', 'reconcile', '--session', sessionId, '--all', '--json'])).stderr ?? '',
    );
    expect(failure.error).toEqual({
      code: 'INVALID_ARGUMENT',
      message: 'Pass either --session <id> or --all, not both.',
    });
  });

  it('renders current session commands in help output', async () => {
    const rootHelp = await runCli(repoDir, ['--help']);
    expect(rootHelp.stdout).toContain('session');
    expect(rootHelp.stdout).toContain('artifact');
    expect(rootHelp.stdout).not.toMatch(/^\s+(start|status|capture|daemon)\b/m);
    expect(rootHelp.stderr).toBe('');

    const artifactHelp = await runCli(repoDir, ['artifact', 'generate', '--help']);
    expect(artifactHelp.stdout).toContain('--session <id>');
    expect(artifactHelp.stdout).toContain('--json');
    expect(artifactHelp.stderr).toBe('');

    const sessionHelp = await runCli(repoDir, ['session', '--help']);
    expect(sessionHelp.stdout).toContain('start');
    expect(sessionHelp.stdout).toContain('list');
    expect(sessionHelp.stdout).toContain('status');
    expect(sessionHelp.stdout).toContain('capture');
    expect(sessionHelp.stdout).toContain('heartbeat');
    expect(sessionHelp.stdout).toContain('transition');
    expect(sessionHelp.stdout).toContain('next');
    expect(sessionHelp.stdout).not.toContain('finish');

    const transitionHelp = await runCli(repoDir, ['session', 'transition', '--help']);
    expect(transitionHelp.stdout).toContain('<target-state>');
    expect(transitionHelp.stdout).toContain('--expected-state-version <version>');
    expect(transitionHelp.stdout).toContain('--idempotency-key <key>');
    expect(transitionHelp.stdout).toContain('--actor <actor>');
    expect(transitionHelp.stdout).toContain('--input <json-object>');
    expect(transitionHelp.stdout).toContain('structured transition input, including');
    expect(transitionHelp.stdout).toContain('proof_plan or pre_pr_review when required');
    expect(transitionHelp.stdout).toContain('--json');

    const nextHelp = await runCli(repoDir, ['session', 'next', '--help']);
    expect(nextHelp.stdout).toContain('--session <id>');
    expect(nextHelp.stdout).toContain('--json');

    const removedRoot = parseJsonOutput<{ error: { code: string } }>(
      (await runCliFailure(repoDir, ['finish', '--json'])).stderr ?? '',
    );
    expect(removedRoot.error.code).toBe('INVALID_ARGUMENT');
    const removedSession = parseJsonOutput<{ error: { code: string } }>(
      (await runCliFailure(repoDir, ['session', 'finish', '--json'])).stderr ?? '',
    );
    expect(removedSession.error.code).toBe('INVALID_ARGUMENT');

    const sessionStartHelp = await runCli(repoDir, ['session', 'start', '--help']);
    expect(sessionStartHelp.stdout).toContain('--json');
    expect(sessionStartHelp.stdout).toContain('--goal <goal>');
    expect(sessionStartHelp.stdout).toContain('--constraint <constraint...>');
    expect(sessionStartHelp.stdout).toContain('defaults to');
    expect(sessionStartHelp.stdout).toContain('main when available');
    expect(sessionStartHelp.stdout).toContain('--issue <ref>');
    expect(sessionStartHelp.stdout).toContain('--actor <actor>');
    expect(sessionStartHelp.stderr).toBe('');
  });

  it('renders a derived protocol contract in json mode', async () => {
    const protocol = parseJsonOutput<{
      ok: true;
      command: string;
      data: ReturnType<typeof buildProtocolContract>;
    }>((await runCli(repoDir, ['protocol', '--json'])).stdout);

    expect(protocol).toMatchObject({ ok: true, command: 'protocol' });
    expect(protocol.data).toEqual(buildProtocolContract(createThreadloopProgram()));
    expect(protocol.data.envVars).toEqual({
      EDITOR: 'Editor command used by --edit and --goal-edit flows.',
    });
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
    expect(protocol.data.commands.finish).toBeUndefined();
    expect(protocol.data.commands['session finish']).toBeUndefined();
    expect(protocol.data.commands.init).toBe('threadloop init - Initialize ThreadLoop in the current Git repo');
    expect(protocol.data.workflow.defaultBaseRef).toBe('main');
    expect(protocol.data.workflow.branchNaming.default).toBe('threadloop/<slug>');
    expect(protocol.data.workflow.rebaseBeforePr.upstream).toBe('origin/main');
    expect(protocol.data.workflow.pr.bodyArtifact).toBe('pr-summary');
    expect(protocol.data.workflow.trackedFileMutations).toBe('none');
    expect(protocol.data.notes).not.toContain('Use --json flag for machine-readable output on any command');
  });

  it('reconciles a specific session and persists the snapshot', async () => {
    await runCli(repoDir, ['init']);
    const started = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Reconcile test', '--goal', 'Test reconcile', '--json'])).stdout,
    );
    const sessionId = started.data.session_id;

    const reconcile = parseJsonOutput<{
      ok: true;
      command: string;
      data: { reconciled: number; sessions: Array<{ session_id: string; branch: string; head_sha: string }> };
    }>((await runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json'])).stdout);

    expect(reconcile).toMatchObject({
      ok: true,
      command: 'session reconcile',
      data: {
        reconciled: 1,
        sessions: [{ session_id: sessionId }],
      },
    });

    const reReconcile = parseJsonOutput<{
      data: { sessions: Array<{ session_id: string; previous_head_sha: string | null }> };
    }>((await runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json'])).stdout);
    expect(reReconcile.data.sessions[0]?.previous_head_sha).toBeTruthy();
  });

  it('reconciles all active sessions with --all', async () => {
    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['session', 'start', 'First task', '--goal', 'First goal', '--json']);
    await runCli(repoDir, ['session', 'start', 'Second task', '--goal', 'Second goal', '--json']);

    const reconcile = parseJsonOutput<{
      data: { reconciled: number };
    }>((await runCli(repoDir, ['session', 'reconcile', '--all', '--json'])).stdout);

    expect(reconcile.data.reconciled).toBe(2);
  });

  it('reconcile fails without --session or --all', async () => {
    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['session', 'start', 'Test task', '--goal', 'Test goal']);

    const failure = parseJsonOutput<{ error: { code: string } }>(
      (await runCliFailure(repoDir, ['session', 'reconcile', '--json'])).stderr ?? '',
    );
    expect(failure.error.code).toBe('RECONCILE_TARGET_REQUIRED');
  });

  it('reconcile does not create semantic entries', async () => {
    await runCli(repoDir, ['init']);
    const started = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Entry test', '--goal', 'Test goal', '--json'])).stdout,
    );
    const sessionId = started.data.session_id;

    await runCli(repoDir, ['session', 'capture', 'decision', 'Pre-reconcile decision', '--session', sessionId]);
    await runCli(repoDir, ['session', 'reconcile', '--session', sessionId]);
    await runCli(repoDir, ['session', 'capture', 'decision', 'Post-reconcile decision', '--session', sessionId]);

    const status = parseJsonOutput<{
      data: { entries: { kinds: Record<string, number> } };
    }>((await runCli(repoDir, ['session', 'status', '--session', sessionId, '--json'])).stdout);

    expect(status.data.entries.kinds.decision).toBe(2);
    expect(status.data.entries.kinds.note).toBeUndefined();
    expect(status.data.entries.kinds.intent).toBe(1);
  });

  it('keeps SQLite-backed state intact across repeated concurrent mutation bursts', async () => {
    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = true;\n', 'utf8');

    const roundCount = 2;
    for (let round = 0; round < roundCount; round += 1) {
      const started = parseJsonOutput<{ data: { session_id: string } }>(
        (
          await runCli(repoDir, [
            'session',
            'start',
            `Concurrent flow ${round + 1}`,
            '--goal',
            'Stress SQLite writes',
            '--json',
          ])
        ).stdout,
      );

      await runConcurrentMutationBurst(repoDir, started.data.session_id, `Concurrent flow ${round + 1}`);
    }

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(readScalarCount(db, 'SELECT COUNT(*) AS count FROM sessions')).toBe(roundCount);
      expect(readScalarCount(db, 'SELECT COUNT(*) AS count FROM repo_snapshots')).toBe(roundCount);
      expect(readScalarCount(db, 'SELECT COUNT(*) AS count FROM active_sessions')).toBe(roundCount);
    } finally {
      db.close();
    }
  });

  it('assembles the explicit v2 flow end to end on SQLite state', async () => {
    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const value = 1;\n', 'utf8');

    const started = parseJsonOutput<{ data: { session_id: string } }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Full v2 flow',
          '--goal',
          'Prove the assembled session contract',
          '--json',
        ])
      ).stdout,
    );
    const sessionId = started.data.session_id;

    await runCli(repoDir, [
      'session',
      'capture',
      'decision',
      'Keep explicit session targeting',
      '--session',
      sessionId,
      '--json',
    ]);
    await runCli(repoDir, [
      'session',
      'capture',
      'validation',
      'Verified stored snapshot refresh',
      '--session',
      sessionId,
      '--json',
    ]);
    await runCli(repoDir, ['session', 'heartbeat', '--session', sessionId, '--source', 'daemon', '--json']);
    await runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json']);

    const artifact = parseJsonOutput<{ data: { artifact: { path: string } } }>(
      (await runCli(repoDir, ['artifact', 'generate', '--session', sessionId, '--json'])).stdout,
    );
    const status = parseJsonOutput<{
      data: {
        session: { ended_at: string | null; last_heartbeat_source: string | null };
        entries: { count: number; kinds: Record<string, number> };
        repo_snapshot: { branch: string; headSha: string; changedFiles: string[] } | null;
      };
    }>((await runCli(repoDir, ['session', 'status', '--session', sessionId, '--json'])).stdout);
    const transitioned = parseJsonOutput<{ data: { session_id: string } }>(
      (
        await runCli(repoDir, [
          'session',
          'transition',
          'framed',
          '--session',
          sessionId,
          '--expected-state-version',
          '0',
          '--idempotency-key',
          'v2-flow:framed',
          '--actor',
          'agent',
          '--input',
          '{}',
          '--json',
        ])
      ).stdout,
    );
    const listed = parseJsonOutput<{
      data: { sessions: Array<{ session_id: string; active: boolean; ended_at: string | null }> };
    }>((await runCli(repoDir, ['session', 'list', '--json'])).stdout);

    expect(status.data.entries.count).toBe(3);
    expect(status.data.entries.kinds.intent).toBe(1);
    expect(status.data.entries.kinds.decision).toBe(1);
    expect(status.data.entries.kinds.validation).toBe(1);
    expect(status.data.session.ended_at).toBeNull();
    expect(status.data.session.last_heartbeat_source).toBe('daemon');
    expect(status.data.repo_snapshot?.changedFiles).toContain('feature.ts');
    expect(transitioned.data.session_id).toBe(sessionId);
    const listedSession = listed.data.sessions.find((session) => session.session_id === sessionId);
    expect(listedSession).toMatchObject({
      session_id: sessionId,
      active: true,
    });
    expect(listedSession?.ended_at).toBeNull();

    const renderedArtifact = await readFile(path.join(repoDir, artifact.data.artifact.path), 'utf8');
    expect(renderedArtifact).toContain('feature.ts');
    expect(renderedArtifact).not.toContain('.threadloop/');
  });

  it('renders reconcile command in help output', async () => {
    const sessionHelp = await runCli(repoDir, ['session', '--help']);
    expect(sessionHelp.stdout).toContain('reconcile');
  });
});

function readScalarCount(db: DatabaseSync, sql: string) {
  const row = db.prepare(sql).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

function readParameterizedCount(db: DatabaseSync, sql: string, value: string) {
  const row = db.prepare(sql).get(value) as { count: number } | undefined;
  return row?.count ?? 0;
}
