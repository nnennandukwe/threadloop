import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../src/adapters/crypto/sha256.js';
import { observeProofRepository } from '../src/adapters/git/client.js';
import { runGateProcess } from '../src/adapters/process/gate-runner.js';
import { canonicalizeSignedGateReceiptArtifact, type SignedGateReceiptArtifact } from '../src/domain/attestation.js';
import { canonicalJson } from '../src/domain/canonical-json.js';
import { canonicalizeProofPlan, type GateReceiptResult } from '../src/domain/proof.js';
import { requiredEnvironment } from './sensor-environment.js';

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
const processResult = await runGateProcess({
  command: gate.command,
  cwd: gateWorkingDirectory,
  timeoutMs: gate.timeout_ms,
  stdoutPath,
  stderrPath,
  env: gateEnvironment(),
});

let after: Awaited<ReturnType<typeof observeProofRepository>>;
let result: GateReceiptResult = processResult.result;
try {
  after = await observeProofRepository(sourceRoot);
} catch {
  after = { ...before, clean: false };
  result = 'invalidated';
}
if (!before.clean || !after.clean || before.headSha !== after.headSha || before.headSha !== sourceHead) {
  result = 'invalidated';
}

const artifact: SignedGateReceiptArtifact = {
  schema_version: 1,
  receipt_id: `report_${randomUUID()}`,
  session_id: sessionId,
  plan_sha256: planSha256,
  gate,
  result,
  started_at: processResult.startedAt,
  ended_at: processResult.endedAt,
  duration_ms: processResult.durationMs,
  exit_status: processResult.exitStatus,
  signal: processResult.signal,
  head_before: before.headSha,
  head_after: after.headSha,
  clean_before: before.clean,
  clean_after: after.clean,
  output: {
    stdout_sha256: processResult.stdout.sha256,
    stderr_sha256: processResult.stderr.sha256,
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
    contract_version: 1,
  },
};
const canonicalArtifact = canonicalizeSignedGateReceiptArtifact(artifact, sha256);
await writeFile(reportPath, canonicalArtifact.json, { encoding: 'utf8', flag: 'wx' });

if (result !== 'passed') {
  process.exitCode = processResult.exitStatus && processResult.exitStatus > 0 ? processResult.exitStatus : 1;
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
