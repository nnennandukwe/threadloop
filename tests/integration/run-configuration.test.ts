import { execFile } from 'node:child_process';
import { copyFile, cp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalizeProofPlan } from '../../src/domain/proof.js';
import { parseJson, runCli, runCliError, transition, transitionFailure } from '../helpers/cli.js';
import {
  cleanupTemporaryState,
  commitFiles,
  git,
  makeCommittedRepo,
  makeTempDir,
  proofPlan,
  recordProofPlan,
  startSession,
} from '../helpers/session.js';
import { countRows, readLifecycle, withStateDb } from '../helpers/state-db.js';

afterEach(cleanupTemporaryState);

it('changes the source fingerprint when the imported receipt schema changes', async () => {
  const sourceRoot = await makeTempDir('threadloop-source-');
  const repoDir = await makeCommittedRepo();
  await Promise.all([
    cp('src', path.join(sourceRoot, 'src'), { recursive: true }),
    copyFile('package.json', path.join(sourceRoot, 'package.json')),
    copyFile('package-lock.json', path.join(sourceRoot, 'package-lock.json')),
    symlink(path.resolve('node_modules'), path.join(sourceRoot, 'node_modules'), 'junction'),
  ]);
  const fingerprintAtStart = async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        path.join(sourceRoot, 'src/cli.ts'),
        'session',
        'start',
        'Source run',
        '--goal',
        'Record the source fingerprint',
        '--json',
      ],
      { cwd: repoDir },
    );
    const { session_id } = parseJson<{ data: { session_id: string } }>(stdout).data;
    const audit = await runCli(repoDir, ['audit', 'show', '--session', session_id, '--json']);
    const { events } = parseJson<{
      data: { events: Array<{ event: { payload: { run_configuration: { implementation_sha256: string } } } }> };
    }>(audit.stdout).data;
    const descriptor = events[0]!.event.payload.run_configuration;
    expect(descriptor).toMatchObject({ implementation_scope: 'source_and_lockfile' });
    return descriptor.implementation_sha256;
  };
  const schemaPath = path.join(sourceRoot, 'src/contracts/gaap/terminal-run-v1.schema.json');
  const original = await readFile(schemaPath, 'utf8');
  const schema = parseJson<{ properties: { subject: { maxItems: number } } }>(original);
  const before = await fingerprintAtStart();
  schema.properties.subject.maxItems++;
  await writeFile(schemaPath, JSON.stringify(schema));
  expect(await fingerprintAtStart()).not.toBe(before);
  await writeFile(schemaPath, original);
  expect(await fingerprintAtStart()).toBe(before);
});

it('captures immutable startup digests without admitting the declared plan as lifecycle evidence', async () => {
  const repoDir = await makeCommittedRepo();
  const plan = proofPlan();
  await writeFile(path.join(repoDir, 'proof.json'), JSON.stringify(plan));
  await writeFile(path.join(repoDir, 'runner.md'), '# Caller runner snapshot\n');
  const configPath = path.join(repoDir, 'run.json');
  await writeFile(
    configPath,
    JSON.stringify({
      harness: 'fixture-harness/1',
      model: 'fixture-model/1',
      proof_plan_path: 'proof.json',
      runner_skill_path: 'runner.md',
    }),
  );
  const { session_id: sessionId } = await startSession(repoDir, 'Attributed run', ['--run-config', configPath]);
  const show = async () =>
    parseJson<{ data: { events: Array<{ event: { payload: Record<string, unknown> } }> } }>(
      (await runCli(repoDir, ['audit', 'show', '--session', sessionId, '--json'])).stdout,
    ).data.events[0]!.event.payload.run_configuration;
  const identity = await show();
  expect(identity).toMatchObject({
    schema_version: 'threadloop.run-configuration/1',
    threadloop_version: '0.1.0',
    storage_schema_version: 8,
    protocol_components: { protocol: 4, proofPlan: 4, sessionNext: 4 },
    caller: { harness: 'fixture-harness/1', model: 'fixture-model/1' },
    proof_plan_sha256: canonicalizeProofPlan(plan, sha256).sha256,
    runner_skill_sha256: sha256('# Caller runner snapshot\n'),
    implementation_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
  });
  expect(JSON.stringify(identity)).not.toContain(repoDir);
  await writeFile(configPath, '{}');
  await writeFile(path.join(repoDir, 'runner.md'), 'changed');
  expect(await show()).toEqual(identity);
  withStateDb(
    repoDir,
    (db) => {
      expect(() => db.exec("UPDATE audit_events SET event_json = '{}' WHERE sequence = 1")).toThrow();
    },
    { readOnly: false },
  );
  await transition(repoDir, sessionId, 'framed', 0, 'identity:frame');
  expect(await transitionFailure(repoDir, sessionId, 'proof_ready', 1, 'identity:no-proof')).toMatchObject({
    error: { code: 'INVALID_ARGUMENT' },
  });
  expect(readLifecycle(repoDir)).toMatchObject({ status: 'framed', state_version: 1 });
  expect(countRows(repoDir, 'proof_plans')).toBe(0);
  expect(await show()).toEqual(identity);
});

it('records unknown caller attribution when the compatible startup path omits configuration', async () => {
  const repoDir = await makeCommittedRepo();
  const { session_id: sessionId } = await startSession(repoDir);
  expect(parseJson((await runCli(repoDir, ['audit', 'show', '--session', sessionId, '--json'])).stdout)).toMatchObject({
    data: {
      events: [
        {
          event: {
            payload: {
              run_configuration: {
                caller: null,
                proof_plan_sha256: null,
                runner_skill_sha256: null,
              },
            },
          },
        },
      ],
    },
  });
});

it.each([
  '{}',
  '{',
  JSON.stringify({ harness: 'h', model: null, proof_plan_path: 'missing', runner_skill_path: 'missing' }),
])('rejects invalid configuration before initializing or creating a session: %s', async (contents) => {
  const repoDir = await makeCommittedRepo();
  const configPath = path.join(repoDir, 'bad.json');
  await writeFile(configPath, contents);
  expect(
    await runCliError(repoDir, ['session', 'start', 'Bad', '--goal', 'Bad', '--run-config', configPath, '--json']),
  ).toMatchObject({
    error: { code: 'INVALID_ARGUMENT', details: { field: 'run_config', hint: expect.any(String) as unknown } },
  });
  await expect(readFile(path.join(repoDir, '.threadloop/config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['matched', 'mismatched'] as const)(
  'records a %s later binding without giving startup metadata guard authority',
  async (binding) => {
    const repoDir = await makeCommittedRepo();
    const declared = proofPlan();
    await commitFiles(repoDir, 'declare configuration', {
      'proof.json': JSON.stringify(declared),
      'runner.md': '# Runner snapshot\n',
      'run.json': JSON.stringify({
        harness: 'fixture',
        model: null,
        proof_plan_path: 'proof.json',
        runner_skill_path: 'runner.md',
      }),
    });
    const { session_id: sessionId } = await startSession(repoDir, 'Binding', [
      '--run-config',
      path.join(repoDir, 'run.json'),
    ]);
    await git(repoDir, 'add', '.threadloop/config.json');
    await git(repoDir, 'commit', '-m', 'initialize ThreadLoop');
    await transition(repoDir, sessionId, 'framed', 0, 'binding:frame');
    const actual = binding === 'matched' ? declared : proofPlan({ command: ['node', '-e', 'process.exit(0)'] });
    await recordProofPlan(repoDir, sessionId, actual);
    expect(readLifecycle(repoDir)).toMatchObject({ status: 'proof_ready', state_version: 2 });
    const exported = parseJson<{ data: { sessions: Array<{ proof_plan_binding: string; attribution: string }> } }>(
      (await runCli(repoDir, ['audit', 'corpus', '--all', '--output', path.join(repoDir, 'bound.jsonl'), '--json']))
        .stdout,
    ).data;
    expect(exported.sessions[0]).toMatchObject({ proof_plan_binding: binding, attribution: 'declared' });
  },
);
