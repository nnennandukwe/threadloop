import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../src/adapters/crypto/sha256.js';
import { observeProofRepository } from '../src/adapters/git/client.js';
import { classifyGateOutcome, runGateWithSetup, toRecordedSetupStep } from '../src/adapters/process/gate-runner.js';
import { canonicalizeSignedGateReceiptArtifact, type SignedGateReceiptArtifact } from '../src/domain/attestation.js';
import { canonicalJson } from '../src/domain/canonical-json.js';
import { canonicalizeProofPlan, type GateReceiptResult } from '../src/domain/proof.js';
import { requiredEnvironment } from './sensor-environment.js';

/** sha256 of the empty string, recorded when a blocked gate produced no output stream at all. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sessionId = requiredEnvironment('THREADLOOP_SESSION_ID');
const planSha256 = requiredEnvironment('THREADLOOP_PLAN_SHA256');
const gateId = requiredEnvironment('THREADLOOP_GATE_ID');
const gateJson = requiredEnvironment('THREADLOOP_GATE_JSON');
const sourceRoot = path.resolve(requiredEnvironment('THREADLOOP_SOURCE_ROOT'));
const reportPath = path.resolve(requiredEnvironment('THREADLOOP_REPORT_PATH'));
const sourceRepository = `${requiredEnvironment('GITHUB_SERVER_URL')}/${requiredEnvironment('GITHUB_REPOSITORY')}`;
const sourceRef = requiredEnvironment('GITHUB_REF');
const sourceHead = requiredEnvironment('GITHUB_SHA');
const runInvocationUri =
  `${sourceRepository}/actions/runs/${requiredEnvironment('GITHUB_RUN_ID')}` +
  `/attempts/${requiredEnvironment('GITHUB_RUN_ATTEMPT')}`;

if (!/^session_[A-Za-z0-9_-]+$/.test(sessionId)) {
  throw new Error('THREADLOOP_SESSION_ID must be a ThreadLoop session id.');
}
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository)) {
  throw new Error(
    'The reusable sensor requires a canonical https://github.com/<owner>/<repo> URL accessible to the workflow.',
  );
}
if (!/^[a-f0-9]{64}$/.test(planSha256)) {
  throw new Error('THREADLOOP_PLAN_SHA256 must be 64 lowercase hexadecimal characters.');
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(gateId)) {
  throw new Error('THREADLOOP_GATE_ID is invalid.');
}
if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(sourceRef)) {
  throw new Error('The reusable sensor accepts only branch refs.');
}
if (!/^[a-f0-9]{40}$/.test(sourceHead)) {
  throw new Error('GITHUB_SHA must be a full lowercase commit SHA.');
}

const parsedGate = JSON.parse(gateJson) as unknown;
const gate = canonicalizeProofPlan(
  { acceptance_criteria: ['Execute the caller-declared CI gate'], gates: [parsedGate] },
  sha256,
).plan.gates[0];
if (!gate || gate.id !== gateId || canonicalJson(gate) !== canonicalJson(parsedGate)) {
  throw new Error('THREADLOOP_GATE_JSON must be the exact declared gate identified by THREADLOOP_GATE_ID.');
}

const before = await observeProofRepository(sourceRoot);
if (before.headSha !== sourceHead) {
  throw new Error('The checked-out source HEAD does not match the caller SHA.');
}
const canonicalSourceRoot = await realpath(sourceRoot);
const gateWorkingDirectory = await realpath(path.resolve(canonicalSourceRoot, gate.working_directory));
const workingDirectoryRelative = path.relative(canonicalSourceRoot, gateWorkingDirectory);
if (
  workingDirectoryRelative === '..' ||
  workingDirectoryRelative.startsWith(`..${path.sep}`) ||
  path.isAbsolute(workingDirectoryRelative)
) {
  throw new Error('The declared gate working directory resolves outside the caller repository.');
}

const reportDirectory = path.dirname(reportPath);
await mkdir(reportDirectory, { recursive: true });
const stdoutPath = path.join(reportDirectory, 'gate.stdout');
const stderrPath = path.join(reportDirectory, 'gate.stderr');

const declaredSetup = gate.setup ?? [];
const setupDirectories = await Promise.all(
  declaredSetup.map(async (step) => {
    const resolved = await realpath(path.resolve(canonicalSourceRoot, step.working_directory));
    const relative = path.relative(canonicalSourceRoot, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Declared setup step ${step.id} resolves outside the caller repository.`);
    }
    return resolved;
  }),
);
// The same routine and classifier the local path uses, so both receipts describe setup identically.
const execution = await runGateWithSetup({
  setup: declaredSetup.map((step, index) => ({
    id: step.id,
    command: step.command,
    workingDirectory: step.working_directory,
    cwd: setupDirectories[index] as string,
    timeoutMs: step.timeout_ms,
    stdoutPath: path.join(reportDirectory, `setup-${index}-${step.id}.stdout`),
    stderrPath: path.join(reportDirectory, `setup-${index}-${step.id}.stderr`),
    // Declared setup is caller-controlled too, so it runs with the same sanitized environment as the gate.
    env: gateEnvironment(),
  })),
  gate: {
    command: gate.command,
    cwd: gateWorkingDirectory,
    timeoutMs: gate.timeout_ms,
    stdoutPath,
    stderrPath,
    env: gateEnvironment(),
  },
  observedBefore: before,
  observe: () => observeProofRepository(sourceRoot).catch(() => null),
});

let after: Awaited<ReturnType<typeof observeProofRepository>>;
let observationFailed = false;
try {
  after = await observeProofRepository(sourceRoot);
} catch {
  after = { ...before, clean: false };
  observationFailed = true;
}
// The CI path's notion of an unchanged repository pins the caller SHA, where the local path pins the bound
// branch. Everything after this point is shared.
const invalidated =
  observationFailed ||
  !before.clean ||
  !after.clean ||
  before.headSha !== after.headSha ||
  before.headSha !== sourceHead;
const result: GateReceiptResult = classifyGateOutcome({ setup: execution.setup, gate: execution.gate, invalidated });

const artifact: SignedGateReceiptArtifact = {
  schema_version: 2,
  receipt_id: `report_${randomUUID()}`,
  session_id: sessionId,
  plan_sha256: planSha256,
  gate,
  result,
  setup: execution.setup.map(toRecordedSetupStep),
  started_at: execution.window.startedAt,
  ended_at: execution.window.endedAt,
  duration_ms: execution.window.durationMs,
  exit_status: execution.gate?.exitStatus ?? null,
  signal: execution.gate?.signal ?? null,
  head_before: before.headSha,
  head_after: after.headSha,
  clean_before: before.clean,
  clean_after: after.clean,
  output: {
    // Empty digests when failing setup blocked the gate, so nothing claims output the gate never produced.
    stdout_sha256: execution.gate?.stdout.sha256 ?? EMPTY_SHA256,
    stderr_sha256: execution.gate?.stderr.sha256 ?? EMPTY_SHA256,
  },
  source: {
    repository: sourceRepository,
    ref: sourceRef,
    head_sha: sourceHead,
    run_invocation_uri: runInvocationUri,
  },
  environment: {
    runner_environment: 'github-hosted',
    runner_os: requiredEnvironment('RUNNER_OS'),
    runner_arch: requiredEnvironment('RUNNER_ARCH'),
    node_version: process.version,
  },
  sensor: {
    name: 'threadloop-github-actions-gate',
    contract_version: 2,
  },
};
const canonicalArtifact = canonicalizeSignedGateReceiptArtifact(artifact, sha256);
await writeFile(reportPath, canonicalArtifact.json, { encoding: 'utf8', flag: 'wx' });

if (result !== 'passed') {
  const exitStatus =
    execution.gate?.exitStatus ?? execution.setup.find((step) => step.process.exitStatus)?.process.exitStatus;
  process.exitCode = exitStatus && exitStatus > 0 ? exitStatus : 1;
}

function gateEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith('THREADLOOP_') ||
      name.startsWith('ACTIONS_') ||
      ['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STEP_SUMMARY', 'GITHUB_TOKEN', 'GH_TOKEN'].includes(name)
    ) {
      delete environment[name];
    }
  }
  return environment;
}
