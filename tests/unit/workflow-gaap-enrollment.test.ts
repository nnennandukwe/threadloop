import { chmod, copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { gaapVerificationPolicy, type GaapHost } from '../../src/domain/gaap-binding.js';
import {
  prepareWorkflowGenesis,
  validateWorkflowGenesis,
  workflowCreateRequestJson,
} from '../../src/services/workflow-genesis.js';
import { workflowDigest } from '../../src/domain/workflow-selection-types.js';
import { createWorkflowStore } from '../../src/adapters/fs/workflow-store.js';
import { initThreadloop } from '../../src/services/session-service.js';
import {
  applyWorkflowRun,
  createWorkflowRun,
  decideWorkflowRun,
  inspectWorkflowRun,
} from '../../src/services/workflow-runtime.js';
import { executeWorkflowRun } from '../../src/services/workflow-execution.js';
import type { WorkflowSetup, WorkflowSources } from '../../src/domain/workflow-run.js';
import { controllerBinding } from '../fixtures/gaap-controller.js';
import { gaapFixture } from '../fixtures/gaap.js';
import { cleanupTemporaryState, git, makeTempDir } from '../helpers/session.js';
import { governedProfile, governedWorkflowFixture } from '../helpers/workflow-run.js';

afterEach(cleanupTemporaryState);

async function enrolled() {
  const { control, subject } = await governedWorkflowFixture(['local-gate']);
  const hostRoot = await makeTempDir();
  const executable = path.join(hostRoot, 'producer');
  const script = path.join(hostRoot, 'task.mjs');
  await copyFile('/bin/echo', executable);
  await chmod(executable, 0o755);
  await writeFile(script, 'original producer entry point\n');
  const fixture = await gaapFixture();
  const host: GaapHost = {
    schema_version: 'threadloop.gaap-host/1',
    executable,
    arguments: [script],
    workspace: subject,
    environment: {},
    timeout_ms: 1000,
    verification: {
      id: 'gaap_auth',
      keys: fixture.keys.map((key) => ({
        key_id: key.keyId,
        public_key_hex: Buffer.from(key.publicKey).toString('hex'),
      })),
      implementation: { name: 'fixture', version: '1', digest: 'sha256:' + 'a'.repeat(64) },
    },
  };
  fixture.expected.approval_context = [];
  const binding = await controllerBinding(subject, host, fixture.expected);
  const adapter = {
    schema_version: 'threadloop.workflow-gaap-adapter/1',
    mapping_policy: binding.mapping_policy,
    parameters: binding.parameters,
    executor: binding.executor,
    lease_ms: binding.lease_ms,
    execution_policy: { id: 'run-execution', retry_safety: 'reconciliation_required', max_attempts: 1 },
  };
  const setup = {
    ...(JSON.parse(await readFile(path.join(control, 'setup.json'), 'utf8')) as WorkflowSetup),
    schema_version: 'threadloop.workflow-setup/2',
    gaap: { adapter: './adapter.json', host: './host.json' },
  };
  await writeFile(path.join(control, 'setup.json'), JSON.stringify(setup));
  await writeFile(path.join(control, 'adapter.json'), JSON.stringify(adapter));
  await writeFile(path.join(control, 'host.json'), JSON.stringify(host));
  const prepare = () => prepareWorkflowGenesis(control, 'session_wf_managed', governedProfile, 'setup.json');
  return { control, subject, host, adapter, script, setup, prepare };
}

it('adopts the exact GAAP implementation, parameters and executable files before advertising execution', async () => {
  const { prepare, host, adapter } = await enrolled();
  const prepared = prepare();
  const genesis = prepared.build('2026-11-21T00:00:00.000Z');
  expect(genesis.source_policies['pre-pr-review']).toBeUndefined();
  expect(genesis.gaap?.host).toEqual(host);
  expect(genesis.gaap?.adapter).toEqual(adapter);
  expect(genesis.policy.rules.evidence_policies).toContainEqual(gaapVerificationPolicy(host));
  expect(prepared.requestJson).toContain(genesis.gaap!.host_digest);
  expect(() => validateWorkflowGenesis(genesis)).not.toThrow();
});

it('accepts producer data and rejects an unsupported environment or script entry at adoption', async () => {
  const { control, subject, host, prepare } = await enrolled();
  host.environment = {
    PRODUCER_LABEL: 'ready',
    GAAP_SETTINGS: '{"format":"report/v1"}',
    PRODUCER_OUTPUT_DIRECTORY: control,
  };
  await writeFile(path.join(control, 'host.json'), JSON.stringify(host));
  expect(prepare().build('2026-11-21T00:00:00.000Z').gaap?.host.environment).toEqual(host.environment);
  for (const environment of [
    { UNKNOWN_OPTION: 'example' },
    { PATH: 'unused' },
    { PRODUCER_CONFIG: './absent.json' },
    { PRODUCER_INPUT_FILE: path.join(control, 'missing') },
    { PRODUCER_OUTPUT_DIRECTORY: subject },
    { PRODUCER_OUTPUT_DIRECTORY: 'relative' },
  ]) {
    await writeFile(path.join(control, 'host.json'), JSON.stringify({ ...host, environment }));
    expect(prepare).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  }
  await writeFile(host.executable, '#!/bin/sh\n# Inert format sample.\n');
  await writeFile(path.join(control, 'host.json'), JSON.stringify(host));
  expect(prepare).toThrow(/native.*interpreter/i);
});

it('inspects an older stored host and refuses its unsupported environment before reserving an execution', async () => {
  const { control, prepare } = await enrolled();
  const at = '2026-11-21T00:00:00.000Z';
  const retained = prepare().build(at);
  retained.gaap!.host.environment.OLD_OPTION = 'retained data';
  retained.gaap!.host_digest = workflowDigest(retained.gaap!.host);
  await git(control, 'init', '-b', 'main');
  await initThreadloop(control);
  const store = createWorkflowStore(control, () => at);
  store.create(retained.run_id, workflowCreateRequestJson(retained), () => retained);
  const decisionFile = path.join(control, 'decision.json');
  for (const edge of ['frame', 'bind_plan', 'begin_implementation']) {
    const data = await decideWorkflowRun(control, retained.run_id);
    await writeFile(decisionFile, JSON.stringify({ ok: true, command: 'workflow decide', data }));
    await applyWorkflowRun(control, retained.run_id, decisionFile, edge);
  }
  const data = await decideWorkflowRun(control, retained.run_id);
  await writeFile(decisionFile, JSON.stringify({ ok: true, command: 'workflow decide', data }));
  const before = await inspectWorkflowRun(control, retained.run_id);
  expect(store.read(retained.run_id).genesis.gaap).toEqual(retained.gaap);
  await expect(executeWorkflowRun(control, retained.run_id, decisionFile)).rejects.toMatchObject({
    code: 'TRANSITION_GUARD_FAILED',
    details: { reason: 'managed_producer_changed' },
  });
  expect(await inspectWorkflowRun(control, retained.run_id)).toEqual(before);
});

it('keeps historical reads independent of files and refuses dispatch after a producer script changes', async () => {
  const { control, script, prepare } = await enrolled();
  const entry = prepare().build('2026-11-21T00:00:00.000Z');
  const { assertWorkflowGaapExecutable } = await import('../../src/services/workflow-gaap-adapter.js');
  expect(() => assertWorkflowGaapExecutable(entry)).not.toThrow();
  await writeFile(path.join(control, 'adapter.json'), '{}');
  await writeFile(script, 'different adapter bytes\n');
  expect(() => validateWorkflowGenesis(entry)).not.toThrow();
  expect(() => assertWorkflowGaapExecutable(entry)).toThrow(/changed/);
});

it('requires protected executable, argument and environment files before enrolling or starting the host', async () => {
  const { control, host, script, prepare } = await enrolled();
  const configDirectory = await makeTempDir();
  const configFile = path.join(configDirectory, 'producer.json');
  const outputDirectory = await makeTempDir();
  await writeFile(configFile, '{}');
  host.environment.PRODUCER_CONFIG = configFile;
  host.environment.PRODUCER_OUTPUT_DIRECTORY = outputDirectory;
  await writeFile(path.join(control, 'host.json'), JSON.stringify(host));
  await git(control, 'init', '-b', 'main');
  await initThreadloop(control);
  const run = 'session_wf_protected';
  await createWorkflowRun(control, run, governedProfile, 'setup.json');
  const decisionFile = path.join(control, 'decision.json');
  const saveDecision = async () => {
    const data = await decideWorkflowRun(control, run);
    await writeFile(decisionFile, JSON.stringify({ ok: true, command: 'workflow decide', data }));
    return data.controller_decision.decision.outcome;
  };
  for (const edge of ['frame', 'bind_plan', 'begin_implementation']) {
    await saveDecision();
    await applyWorkflowRun(control, run, decisionFile, edge);
  }
  expect(await saveDecision()).toBe('engineering_action_required');
  const previous = await inspectWorkflowRun(control, run);
  for (const filename of [host.executable, script, configFile, configDirectory, outputDirectory]) {
    const mode = (await stat(filename)).mode & 0o7777;
    await chmod(filename, mode | 0o020);
    expect(prepare).toThrow(/only the current account and root|protected absolute directory/);
    await expect(executeWorkflowRun(control, run, decisionFile)).rejects.toMatchObject({
      code: 'TRANSITION_GUARD_FAILED',
      details: { reason: 'managed_producer_changed' },
    });
    expect(await inspectWorkflowRun(control, run)).toEqual(previous);
    await chmod(filename, mode);
  }
  expect(
    (await readdir(path.join(control, '.threadloop'), { recursive: true })).map((name) => path.basename(name)),
  ).not.toContain('executor.sqlite');
});
it('rejects unknown fields and a forged mapping digest during adoption', async () => {
  const { control, adapter, prepare } = await enrolled();
  for (const invalid of [
    { ...adapter, action_request: {} },
    { ...adapter, mapping_policy: { ...adapter.mapping_policy, policy_digest: 'f'.repeat(64) } },
  ]) {
    await writeFile(path.join(control, 'adapter.json'), JSON.stringify(invalid));
    expect(prepare).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  }
});
it('binds the Qodo status executable and base to the review producer at create', async () => {
  const { control, setup, prepare, host } = await enrolled();
  const reader = {
    provider: 'qodo',
    executable: host.executable,
    base_commit: '1'.repeat(40),
    reviewer_id: 'reviewer',
  };
  await writeFile(path.join(control, 'setup.json'), JSON.stringify({ ...setup, review_reader: reader }));
  expect(() => prepare().build('2026-11-21T00:00:00.000Z')).toThrow(/requires a declared pre-PR review source/);
  const sourceFile = path.join(control, 'sources.json');
  const sources = JSON.parse(await readFile(sourceFile, 'utf8')) as WorkflowSources;
  sources.host_producers.push('pre-pr-review');
  await writeFile(sourceFile, JSON.stringify(sources));
  const entry = prepare().build('2026-11-21T00:00:00.000Z');
  const { assertWorkflowReviewReader } = await import('../../src/services/workflow-gaap-adapter.js');
  expect(assertWorkflowReviewReader(entry)).toEqual(reader);
  expect(entry.source_policies['pre-pr-review']).toBeDefined();
  await writeFile(host.executable, 'changed reader bytes');
  expect(() => validateWorkflowGenesis(entry)).not.toThrow();
  expect(() => assertWorkflowReviewReader(entry)).toThrow(/changed/);
});

it('requires a reader for new review-enabled runs and preserves exact replay of an earlier v2 run', async () => {
  const { control, prepare } = await enrolled();
  const at = '2026-11-21T00:00:00.000Z';
  const retained = prepare().build(at);
  // Earlier v2 builds retained the declaration without adding a review policy.
  retained.sources!.host_producers.push('pre-pr-review');
  await writeFile(path.join(control, 'sources.json'), JSON.stringify(retained.sources));
  await git(control, 'init', '-b', 'main');
  await initThreadloop(control);
  const store = createWorkflowStore(control, () => at);
  const historical = store.create(retained.run_id, workflowCreateRequestJson(retained), () => retained);

  await expect(createWorkflowRun(control, 'session_wf_new', governedProfile, 'setup.json')).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
    details: { reason: 'workflow_setup_invalid' },
    message: expect.stringMatching(/pre-pr-review.*review_reader/) as string,
  });
  expect(() => store.read('session_wf_new')).toThrow(expect.objectContaining({ code: 'WORKFLOW_RUN_NOT_FOUND' }));
  expect(await createWorkflowRun(control, retained.run_id, governedProfile, 'setup.json')).toEqual(historical);
  expect(await inspectWorkflowRun(control, retained.run_id)).toMatchObject(historical);
  expect(store.read(retained.run_id).genesis.source_policies['pre-pr-review']).toBeUndefined();
});

it("refuses an adapter whose evidence mapping can't cover the configured action guard", async () => {
  const { control, adapter, prepare } = await enrolled();
  adapter.mapping_policy.policy.evidence_mapping.forEach((item) => {
    item.family = 'review';
  });
  adapter.mapping_policy.policy_digest = workflowDigest(adapter.mapping_policy.policy);
  await writeFile(path.join(control, 'adapter.json'), JSON.stringify(adapter));
  expect(() => prepare().build('2026-11-21T00:00:00.000Z')).toThrow(/evidence family/i);
});
