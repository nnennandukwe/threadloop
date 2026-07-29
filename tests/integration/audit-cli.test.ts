import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { resetSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { exportSessionAudit, transitionSession } from '../../src/services/session-service.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const projectRoot = process.cwd();
const tsxCli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = path.join(projectRoot, 'src/cli.ts');

async function runCli(cwd: string, args: string[]) {
  return execFileAsync('node', [tsxCli, cliEntry, ...args], { cwd });
}

async function runCliFailure(cwd: string, args: string[]) {
  try {
    await runCli(cwd, args);
    throw new Error(`Expected CLI command to fail: ${args.join(' ')}`);
  } catch (error) {
    return error as Error & { stderr?: string };
  }
}

function parseJson<T>(value: string | undefined) {
  return JSON.parse(value ?? '') as T;
}

async function makeSession() {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-audit-cli-'));
  temporaryDirectories.push(repoDir);
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  await writeFile(path.join(repoDir, 'README.md'), '# audit fixture\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repoDir });
  await execFileAsync('git', ['branch', '-M', 'issue-42/audit'], { cwd: repoDir });
  const started = parseJson<{ data: { session_id: string } }>(
    (await runCli(repoDir, ['session', 'start', 'Audit task', '--goal', 'Prove the audit ledger', '--json'])).stdout,
  );
  await runCli(repoDir, [
    'session',
    'transition',
    'framed',
    '--session',
    started.data.session_id,
    '--expected-state-version',
    '0',
    '--idempotency-key',
    'audit:frame',
    '--actor',
    'agent',
    '--input',
    '{}',
    '--json',
  ]);
  return { repoDir, sessionId: started.data.session_id };
}

afterEach(async () => {
  await resetSqliteConnections();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('audit CLI', { timeout: 20_000 }, () => {
  it('shows, verifies, and exclusively exports the canonical hash-linked ledger', async () => {
    const fixture = await makeSession();
    const shown = parseJson<{
      data: {
        contract_version: number;
        session_id: string;
        count: number;
        root: string;
        coverage: string;
        verification: { valid: boolean };
        events: Array<{ event: { event_type: string }; event_sha256: string }>;
      };
    }>((await runCli(fixture.repoDir, ['audit', 'show', '--session', fixture.sessionId, '--json'])).stdout);

    expect(shown.data).toMatchObject({
      contract_version: 1,
      session_id: fixture.sessionId,
      count: 3,
      coverage: 'full',
      verification: { valid: true },
      events: [
        { event: { event_type: 'session_started' } },
        { event: { event_type: 'guard_decision' } },
        { event: { event_type: 'transition_applied' } },
      ],
    });
    expect(shown.data.root).toMatch(/^[a-f0-9]{64}$/);
    expect(shown.data.events.every((event) => /^[a-f0-9]{64}$/.test(event.event_sha256))).toBe(true);

    const textShow = await runCli(fixture.repoDir, ['audit', 'show', '--session', fixture.sessionId]);
    expect(textShow.stdout).toContain(`Audit ${fixture.sessionId}: 3 event(s)`);
    expect(textShow.stdout).toContain('Events:');
    expect(textShow.stdout).toMatch(/#1 session_started \S+ [a-f0-9]{64}/);
    expect(textShow.stdout).toMatch(/#2 guard_decision \S+ [a-f0-9]{64}/);
    expect(textShow.stdout).toMatch(/#3 transition_applied \S+ [a-f0-9]{64}/);

    const verified = parseJson<{ data: { valid: boolean; root: string } }>(
      (
        await runCli(fixture.repoDir, [
          'audit',
          'verify',
          '--session',
          fixture.sessionId,
          '--root',
          shown.data.root,
          '--json',
        ])
      ).stdout,
    );
    expect(verified.data).toEqual(expect.objectContaining({ valid: true, root: shown.data.root }));

    const outputPath = path.join(fixture.repoDir, 'audit-output', 'session.jsonl');
    const exported = parseJson<{ data: { count: number; root: string; output: string } }>(
      (
        await runCli(fixture.repoDir, [
          'audit',
          'export',
          '--session',
          fixture.sessionId,
          '--output',
          outputPath,
          '--json',
        ])
      ).stdout,
    );
    const lines = (await readFile(outputPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => parseJson<{ event: { event_type: string }; event_sha256: string }>(line));
    expect(exported.data).toMatchObject({ count: 3, root: shown.data.root, output: outputPath });
    expect(lines).toHaveLength(3);
    expect(lines[0]?.event.event_type).toBe('session_started');
    expect(lines[0]?.event_sha256).toMatch(/^[a-f0-9]{64}$/);

    const exportFailure = await runCliFailure(fixture.repoDir, [
      'audit',
      'export',
      '--session',
      fixture.sessionId,
      '--output',
      outputPath,
      '--json',
    ]);
    expect(exportFailure.stderr).toContain('"code": "AUDIT_EXPORT_CONFLICT"');
    expect((await readFile(outputPath, 'utf8')).trimEnd().split('\n')).toHaveLength(3);
  });

  it('maps audit export I/O failures to a stable error with the safe output path and recovery hint', async () => {
    const fixture = await makeSession();
    const nonDirectory = path.join(fixture.repoDir, 'not-a-directory');
    await writeFile(nonDirectory, 'blocks directory creation\n', 'utf8');
    const outputPath = path.join(nonDirectory, 'session.jsonl');

    const failure = await runCliFailure(fixture.repoDir, [
      'audit',
      'export',
      '--session',
      fixture.sessionId,
      '--output',
      outputPath,
      '--json',
    ]);
    expect(
      parseJson<{
        error: { code: string; message: string; details: { output: string; hint: string } };
      }>(failure.stderr),
    ).toMatchObject({
      error: {
        code: 'AUDIT_EXPORT_FAILED',
        message: 'ThreadLoop could not publish the verified audit export.',
        details: {
          output: outputPath,
          hint: 'Choose a writable output path whose parent is a directory, then retry the export.',
        },
      },
    });

    let serviceFailure: unknown;
    try {
      await exportSessionAudit({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        outputPath,
      });
    } catch (error) {
      serviceFailure = error;
    }
    expect(serviceFailure).toMatchObject({ code: 'AUDIT_EXPORT_FAILED' });
    expect((serviceFailure as Error).cause).toBeInstanceOf(Error);
  });

  it.each([
    {
      name: 'unavailable',
      expectedCode: 'AUDIT_UNAVAILABLE',
      mutate: (db: DatabaseSync) => {
        db.prepare(`DROP TABLE audit_events`).run();
      },
    },
    {
      name: 'empty',
      expectedCode: 'AUDIT_EMPTY',
      mutate: (db: DatabaseSync) => {
        db.prepare(`DROP TRIGGER audit_events_no_delete`).run();
        db.prepare(`DELETE FROM audit_events`).run();
        db.exec(`
          CREATE TRIGGER audit_events_no_delete
          BEFORE DELETE ON audit_events
          BEGIN
            SELECT RAISE(ABORT, 'audit events are immutable');
          END
        `);
      },
    },
  ])('fails closed when the audit ledger is $name', async ({ expectedCode, mutate }) => {
    const fixture = await makeSession();
    await resetSqliteConnections(fixture.repoDir);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'));
    try {
      mutate(db);
    } finally {
      db.close();
    }

    for (const command of [
      ['audit', 'verify', '--session', fixture.sessionId, '--json'],
      [
        'audit',
        'export',
        '--session',
        fixture.sessionId,
        '--output',
        path.join(fixture.repoDir, `${expectedCode}.jsonl`),
        '--json',
      ],
    ]) {
      const failure = await runCliFailure(fixture.repoDir, command);
      const response = parseJson<{ error: { code: string; details: { session_id: string; hint: string } } }>(
        failure.stderr,
      );
      expect(response).toMatchObject({
        error: {
          code: expectedCode,
          details: {
            session_id: fixture.sessionId,
          },
        },
      });
      expect(response.error.details.hint.length).toBeGreaterThan(0);
    }

    await expect(readFile(path.join(fixture.repoDir, `${expectedCode}.jsonl`), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports corruption and blocks later controller mutations without changing lifecycle state', async () => {
    const fixture = await makeSession();
    await resetSqliteConnections(fixture.repoDir);
    const dbPath = path.join(fixture.repoDir, '.threadloop/state/state.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`DROP TRIGGER audit_events_no_update`).run();
      db.prepare(`UPDATE audit_events SET event_sha256 = ? WHERE sequence = 2`).run('0'.repeat(64));
    } finally {
      db.close();
    }

    const verifyFailure = await runCliFailure(fixture.repoDir, [
      'audit',
      'verify',
      '--session',
      fixture.sessionId,
      '--json',
    ]);
    expect(
      parseJson<{
        error: {
          code: string;
          details: { audit_error: { code: string; sequence: number } };
        };
      }>(verifyFailure.stderr),
    ).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: { audit_error: { code: 'AUDIT_HASH_MISMATCH', sequence: 2 } },
      },
    });
    const transitionFailure = await runCliFailure(fixture.repoDir, [
      'session',
      'transition',
      'blocked',
      '--session',
      fixture.sessionId,
      '--expected-state-version',
      '1',
      '--idempotency-key',
      'audit:block-after-corruption',
      '--actor',
      'agent',
      '--input',
      JSON.stringify({
        block: {
          reason: 'audit corruption',
          evidence_ref: 'audit:2',
          recovery: 'restore ledger',
          stop_code: 'AUDIT_CORRUPT',
        },
      }),
      '--json',
    ]);
    expect(
      parseJson<{
        error: {
          code: string;
          details: { audit_error: { code: string; sequence: number } };
        };
      }>(transitionFailure.stderr),
    ).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: { audit_error: { code: 'AUDIT_HASH_MISMATCH', sequence: 2 } },
      },
    });

    const state = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(state.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'framed',
        state_version: 1,
      });
      expect(
        state
          .prepare(`SELECT COUNT(*) AS count FROM transition_idempotency WHERE idempotency_key = ?`)
          .get('audit:block-after-corruption'),
      ).toEqual({ count: 0 });
    } finally {
      state.close();
    }
  });

  it('invalidates a cached audit root after another connection changes the ledger', async () => {
    const fixture = await makeSession();
    await expect(
      transitionSession({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        targetState: 'blocked',
        expectedStateVersion: 1,
        idempotencyKey: 'audit:cache-root',
        actor: 'agent',
        input: {
          block: {
            reason: 'exercise cached audit verification',
            evidence_ref: 'audit:cache',
            recovery: 'restore the session',
            stop_code: 'AUDIT_CACHE_TEST',
          },
        },
      }),
    ).resolves.toMatchObject({ data: { lifecycle: { state: 'blocked', state_version: 2 } } });

    const dbPath = path.join(fixture.repoDir, '.threadloop/state/state.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`DROP TRIGGER audit_events_no_update`).run();
      db.prepare(`UPDATE audit_events SET event_sha256 = ? WHERE sequence = 1`).run('0'.repeat(64));
      db.exec(`
        CREATE TRIGGER audit_events_no_update
        BEFORE UPDATE ON audit_events
        BEGIN
          SELECT RAISE(ABORT, 'audit events are immutable');
        END
      `);
    } finally {
      db.close();
    }

    await expect(
      transitionSession({
        cwd: fixture.repoDir,
        sessionId: fixture.sessionId,
        targetState: 'framed',
        expectedStateVersion: 2,
        idempotencyKey: 'audit:cache-root:invalidated',
        actor: 'agent',
        input: {
          recovery: {
            reason: 'resume after cache test',
            evidence_ref: 'audit:cache:resolved',
            approved_by: 'Test User',
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'AUDIT_VERIFICATION_FAILED',
      details: { audit_error: { code: 'AUDIT_HASH_MISMATCH', sequence: 1 } },
    });

    const state = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(state.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'blocked',
        state_version: 2,
      });
    } finally {
      state.close();
    }
  });

  it('reports retained-root and row-canonicalization failures with structured reasons', async () => {
    const fixture = await makeSession();
    const rootFailure = await runCliFailure(fixture.repoDir, [
      'audit',
      'verify',
      '--session',
      fixture.sessionId,
      '--root',
      'f'.repeat(64),
      '--json',
    ]);
    expect(
      parseJson<{
        error: { code: string; details: { audit_error: { code: string } } };
      }>(rootFailure.stderr),
    ).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: { audit_error: { code: 'AUDIT_ROOT_MISMATCH' } },
      },
    });

    await resetSqliteConnections(fixture.repoDir);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'));
    try {
      db.prepare(`DROP TRIGGER audit_events_no_update`).run();
      db.prepare(`UPDATE audit_events SET state_version = state_version + 1 WHERE sequence = 2`).run();
    } finally {
      db.close();
    }

    const canonicalizationFailure = await runCliFailure(fixture.repoDir, [
      'audit',
      'verify',
      '--session',
      fixture.sessionId,
      '--json',
    ]);
    expect(
      parseJson<{
        error: {
          code: string;
          details: { audit_error: { code: string; sequence: number } };
        };
      }>(canonicalizationFailure.stderr),
    ).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: {
          audit_error: { code: 'AUDIT_CANONICALIZATION_MISMATCH', sequence: 2 },
        },
      },
    });
  });

  it.each([
    {
      name: 'sequence',
      expectedCode: 'AUDIT_SEQUENCE_MISMATCH',
      mutate: (db: DatabaseSync) => {
        const row = db.prepare(`SELECT event_json FROM audit_events WHERE sequence = 2`).get() as {
          event_json: string;
        };
        const event = { ...(JSON.parse(row.event_json) as Record<string, unknown>), sequence: 4 };
        const eventJson = canonicalJson(event);
        db.prepare(
          `
            UPDATE audit_events
            SET sequence = 4, event_json = ?, event_sha256 = ?
            WHERE sequence = 2
          `,
        ).run(eventJson, sha256(eventJson));
      },
    },
    {
      name: 'link',
      expectedCode: 'AUDIT_LINK_MISMATCH',
      mutate: (db: DatabaseSync) => {
        const row = db.prepare(`SELECT event_json FROM audit_events WHERE sequence = 2`).get() as {
          event_json: string;
        };
        const previousSha256 = 'f'.repeat(64);
        const event = {
          ...(JSON.parse(row.event_json) as Record<string, unknown>),
          previous_sha256: previousSha256,
        };
        const eventJson = canonicalJson(event);
        db.prepare(
          `
            UPDATE audit_events
            SET previous_sha256 = ?, event_json = ?, event_sha256 = ?
            WHERE sequence = 2
          `,
        ).run(previousSha256, eventJson, sha256(eventJson));
      },
    },
  ])('reports a structured $name mismatch through the public command', async ({ expectedCode, mutate }) => {
    const fixture = await makeSession();
    await resetSqliteConnections(fixture.repoDir);
    const db = new DatabaseSync(path.join(fixture.repoDir, '.threadloop/state/state.db'));
    try {
      db.prepare(`DROP TRIGGER audit_events_no_update`).run();
      mutate(db);
    } finally {
      db.close();
    }

    const failure = await runCliFailure(fixture.repoDir, ['audit', 'verify', '--session', fixture.sessionId, '--json']);
    expect(
      parseJson<{
        error: {
          code: string;
          details: { audit_error: { code: string; sequence: number } };
        };
      }>(failure.stderr),
    ).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: { audit_error: { code: expectedCode, sequence: 2 } },
      },
    });
  });
});
