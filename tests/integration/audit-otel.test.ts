import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { parseJson, runCli, runCliError, transitionFailure } from '../helpers/cli.js';
import { cleanupTemporaryState, makeCommittedRepo, makeTempDir, proofPlan, startSession } from '../helpers/session.js';
import { withStateDb } from '../helpers/state-db.js';

afterEach(cleanupTemporaryState);

interface ExportStatus {
  root: string;
  session_count: number;
  event_count: number;
}

interface LogRecord {
  eventName: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }>;
}

function logs(content: string) {
  return content
    .trimEnd()
    .split('\n')
    .flatMap((line) =>
      parseJson<{ resourceLogs: Array<{ scopeLogs: Array<{ logRecords: LogRecord[] }> }> }>(line).resourceLogs.flatMap(
        (resource) => resource.scopeLogs.flatMap((scope) => scope.logRecords),
      ),
    );
}

function storedState(repo: string) {
  return withStateDb(repo, (db) => ({
    tasks: db.prepare('SELECT id, status, state_version FROM tasks ORDER BY id').all(),
    audit: db
      .prepare('SELECT session_id, sequence, event_sha256 FROM audit_events ORDER BY session_id, sequence')
      .all(),
  }));
}

async function exportFile(repo: string, output: string, format?: string) {
  const args = ['audit', 'corpus', '--all', '--output', output, '--json'];
  if (format) args.push('--format', format);
  const { stdout } = await runCli(repo, args);
  return { status: parseJson<{ data: ExportStatus }>(stdout).data, content: await readFile(output, 'utf8') };
}

it('withholds private fields from the viewer and recovers the native snapshot from the controlled format', async () => {
  const repo = await makeCommittedRepo();
  const outside = await makeTempDir();
  const privateHarness = 'private-harness/\u7de8\u96c6';
  const privateModel = 'private-model-for-corpus-test';
  const privateKey = 'private-guard-request';
  await writeFile(path.join(repo, 'plan.json'), JSON.stringify(proofPlan()));
  await writeFile(path.join(repo, 'runner.md'), 'Fixture runner\n');
  await writeFile(
    path.join(repo, 'run.json'),
    JSON.stringify({
      harness: privateHarness,
      model: privateModel,
      proof_plan_path: 'plan.json',
      runner_skill_path: 'runner.md',
    }),
  );
  const { session_id: id } = await startSession(repo, 'Attributed session', ['--run-config', 'run.json']);
  await startSession(repo, 'Runtime-only session');
  expect((await transitionFailure(repo, id, 'completed', 0, privateKey)).error.code).toBe('TRANSITION_NOT_ALLOWED');
  const before = storedState(repo);
  const native = await exportFile(repo, path.join(repo, 'default.jsonl'));
  const explicitPath = path.join(repo, 'native.jsonl');
  const explicit = await exportFile(repo, explicitPath, 'native');
  expect(explicit.content).toBe(native.content);
  expect(explicit.status).toEqual({ ...native.status, output: explicitPath });
  expect(native.status).toMatchObject({ root: sha256(native.content), session_count: 2, event_count: 3 });
  expect(native.status).toHaveProperty('sessions');
  const singlePath = path.join(repo, 'single.jsonl');
  await runCli(repo, ['audit', 'export', '--session', id, '--output', singlePath, '--json']);
  const nativeEvents = native.content
    .trimEnd()
    .split('\n')
    .slice(1, -1)
    .map((row) => parseJson<{ session_id: string; canonical_event: string; event_sha256: string }>(row));
  const singleRows = nativeEvents
    .filter((row) => row.session_id === id)
    .map((row) => `{"event":${row.canonical_event},"event_sha256":"${row.event_sha256}"}`);
  expect(await readFile(singlePath, 'utf8')).toBe(singleRows.join('\n') + '\n');

  const viewerPath = path.join(repo, 'viewer.jsonl');
  const controlledPath = path.join(repo, 'controlled.jsonl');
  const viewer = await exportFile(repo, viewerPath, 'otel');
  const controlled = await exportFile(repo, controlledPath, 'otel-verifiable');
  for (const [exported, format, verification] of [
    [viewer, 'otel', 'projection_only'],
    [controlled, 'otel-verifiable', 'canonical_records'],
  ] as const) {
    expect(exported.status).toMatchObject({
      format,
      verification,
      profile: 'threadloop.audit-otel/1',
      root: sha256(exported.content),
      source_root: native.status.root,
      session_count: 2,
      event_count: 3,
    });
    expect(exported.status).not.toHaveProperty('sessions');
    expect(exported.status).not.toHaveProperty('manifest');
    expect(exported.content.endsWith('\n')).toBe(true);
  }
  for (const marker of [privateHarness, privateModel, privateKey]) {
    expect(native.content).toContain(marker);
    expect(viewer.content).not.toContain(marker);
    expect(JSON.stringify(viewer.status)).not.toContain(marker);
    expect(JSON.stringify(controlled.status)).not.toContain(marker);
  }
  const viewerAttributes = logs(viewer.content).flatMap((log) => log.attributes);
  expect(viewerAttributes).toContainEqual({ key: 'threadloop.guard.allowed', value: { boolValue: false } });
  expect(viewerAttributes).toContainEqual({ key: 'threadloop.audit.state_version', value: { intValue: '0' } });
  const canonicalField = 'threadloop.audit.canonical_record';
  expect(viewer.content).not.toContain(canonicalField);
  const recovered = logs(controlled.content).flatMap((log) =>
    log.attributes
      .filter((attribute) => attribute.key === canonicalField)
      .map((attribute) => attribute.value.stringValue),
  );
  expect(recovered.join('\n') + '\n').toBe(native.content);

  const verifyArgs = (file: string) => ['audit', 'verify-export', '--input', file, '--json'];
  const verified = parseJson<{ data: Record<string, unknown> }>(
    (await runCli(outside, [...verifyArgs(controlledPath), '--root', controlled.status.root])).stdout,
  ).data;
  expect(verified).toMatchObject({
    valid: true,
    format: 'otel-verifiable',
    root: controlled.status.root,
    source_root: native.status.root,
    profile: 'threadloop.audit-otel/1',
    manifest: JSON.parse(native.content.split('\n')[0]!) as unknown,
  });
  const projected = await runCliError(outside, verifyArgs(viewerPath));
  expect(projected.error.code).toBe('AUDIT_CORPUS_INVALID');
  expect(projected.error.details.hint).toContain('otel-verifiable');
  expect((await runCliError(outside, [...verifyArgs(controlledPath), '--root', native.status.root])).error.code).toBe(
    'AUDIT_CORPUS_INVALID',
  );
  const tampered = path.join(repo, 'changed.jsonl');
  const changed = controlled.content.replace(
    '"eventName":"threadloop.audit.manifest"',
    '"eventName":"threadloop.audit.changed"',
  );
  expect(changed).not.toBe(controlled.content);
  await writeFile(tampered, changed);
  expect((await runCliError(outside, verifyArgs(tampered))).error.code).toBe('AUDIT_CORPUS_INVALID');
  expect(await readdir(outside)).toEqual([]);
  await rm(viewerPath);
  await rm(controlledPath);
  expect(storedState(repo)).toEqual(before);
  const retry = await transitionFailure(repo, id, 'completed', 0, 'after-verification', { audit_root: verified.root });
  expect(retry.error.code).toBe('TRANSITION_NOT_ALLOWED');
  expect(storedState(repo).tasks).toEqual(before.tasks);
});

it('preserves an existing target and supports a fresh output after a conflict or invalid format', async () => {
  const repo = await makeCommittedRepo();
  await startSession(repo);
  const target = path.join(repo, 'export.jsonl');
  const args = ['audit', 'corpus', '--all', '--output', target, '--json', '--format'];
  expect((await runCliError(repo, [...args, 'unsupported'])).error.code).toBe('INVALID_ARGUMENT');
  await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(target, 'existing file\n');
  expect((await runCliError(repo, [...args, 'otel-verifiable'])).error.code).toBe('AUDIT_EXPORT_CONFLICT');
  expect(await readFile(target, 'utf8')).toBe('existing file\n');
  const retry = await exportFile(repo, path.join(repo, 'retry.jsonl'), 'otel-verifiable');
  expect(retry.status.root).toBe(sha256(retry.content));
});
