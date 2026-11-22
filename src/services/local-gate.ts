import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { sha256 } from '../adapters/crypto/sha256.js';
import {
  classifyGateOutcome,
  gateExecutionWasInvalidated,
  runGateWithSetup,
  toRecordedSetupStep,
  type GateRepositoryObservation,
  type GateProcessInput,
} from '../adapters/process/gate-runner.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { ProofValidationError, type ProofGate, type GateReceiptPayload } from '../domain/proof.js';

interface LocalGateInput {
  repoRoot: string;
  artifactRoot: string;
  receiptDirectory: string;
  receiptId: string;
  sessionId: string;
  planSha256: string;
  gate: ProofGate;
  before: GateRepositoryObservation;
  observeLocal: () => Promise<GateRepositoryObservation | null>;
  limits?: Pick<GateProcessInput, 'env' | 'maxOutputBytes'>;
  workingDirectories?: ReturnType<typeof resolveGateWorkingDirectories>;
}

export async function produceLocalGate({
  repoRoot,
  artifactRoot,
  receiptDirectory,
  receiptId,
  sessionId,
  planSha256,
  gate,
  before,
  observeLocal,
  limits,
  workingDirectories = resolveGateWorkingDirectories(repoRoot, gate),
}: LocalGateInput) {
  const stdoutPath = path.join(receiptDirectory, 'stdout.log');
  const stderrPath = path.join(receiptDirectory, 'stderr.log');
  const executionPath = path.join(receiptDirectory, 'execution.json');
  const relativeStdoutPath = relativeArtifactPath(artifactRoot, stdoutPath);
  const relativeStderrPath = relativeArtifactPath(artifactRoot, stderrPath);
  const relativeExecutionPath = relativeArtifactPath(artifactRoot, executionPath);

  const declaredSetup = gate.setup ?? [];
  const setupLogPaths = declaredSetup.map((step, index) => ({
    stdoutPath: path.join(receiptDirectory, `setup-${index}-${step.id}.stdout.log`),
    stderrPath: path.join(receiptDirectory, `setup-${index}-${step.id}.stderr.log`),
  }));
  const gateExecution = await runGateWithSetup({
    setup: declaredSetup.map((step, index) => ({
      ...limits,
      id: step.id,
      command: step.command,
      workingDirectory: step.working_directory,
      cwd: workingDirectories.setup[index] as string,
      timeoutMs: step.timeout_ms,
      stdoutPath: (setupLogPaths[index] as { stdoutPath: string }).stdoutPath,
      stderrPath: (setupLogPaths[index] as { stderrPath: string }).stderrPath,
    })),
    gate: {
      ...limits,
      command: gate.command,
      cwd: workingDirectories.gate,
      timeoutMs: gate.timeout_ms,
      stdoutPath,
      stderrPath,
    },
    observedBefore: before,
    observe: observeLocal,
  });
  const after = await observeLocal();
  const invalidated =
    !after ||
    !after.clean ||
    gateExecutionWasInvalidated(gateExecution, before) ||
    after.headSha !== before.headSha ||
    after.branch !== before.branch;
  const recordedSetup = gateExecution.setup.map(toRecordedSetupStep);
  // The local artifact additionally names each setup log on disk, so artifact validation can prove every
  // referenced output exists. The receipt itself carries digests only, matching the signed receipt, which must
  // not embed local paths.
  const recordedSetupArtifacts = recordedSetup.map((step, index) => {
    const logs = setupLogPaths[index] as { stdoutPath: string; stderrPath: string };
    const execution = gateExecution.setup[index] as (typeof gateExecution.setup)[number];
    return {
      ...step,
      stdout: {
        path: relativeArtifactPath(artifactRoot, logs.stdoutPath),
        sha256: execution.process.stdout.sha256,
        bytes: execution.process.stdout.bytes,
      },
      stderr: {
        path: relativeArtifactPath(artifactRoot, logs.stderrPath),
        sha256: execution.process.stderr.sha256,
        bytes: execution.process.stderr.bytes,
      },
    };
  });
  const result = classifyGateOutcome({ setup: gateExecution.setup, gate: gateExecution.gate, invalidated });
  // The execution artifact and the receipt describe one run, so they share these fields verbatim.
  const identity = { session_id: sessionId, gate_id: gate.id, plan_sha256: planSha256, result };
  const run = {
    command: gate.command,
    working_directory: gate.working_directory,
    timeout_ms: gate.timeout_ms,
    started_at: gateExecution.window.startedAt,
    ended_at: gateExecution.window.endedAt,
    duration_ms: gateExecution.window.durationMs,
    exit_status: gateExecution.gate?.exitStatus ?? null,
    signal: gateExecution.gate?.signal ?? null,
    head_before: before.headSha,
    head_after: after?.headSha ?? before.headSha,
    clean_before: before.clean,
    clean_after: after?.clean ?? false,
  };
  const sensor = { name: 'threadloop-local-gate', contract_version: 2 } as const;
  const execution = {
    contract_version: 2,
    receipt_id: receiptId,
    ...identity,
    setup: recordedSetupArtifacts,
    ...run,
    // Null when failing setup blocked the gate command, so no gate output exists to describe.
    stdout: gateExecution.gate
      ? { path: relativeStdoutPath, sha256: gateExecution.gate.stdout.sha256, bytes: gateExecution.gate.stdout.bytes }
      : null,
    stderr: gateExecution.gate
      ? { path: relativeStderrPath, sha256: gateExecution.gate.stderr.sha256, bytes: gateExecution.gate.stderr.bytes }
      : null,
    error: gateExecution.gate?.error ?? null,
    sensor,
  };
  const executionBytes = Buffer.from(`${canonicalJson(execution)}\n`, 'utf8');
  const receipt: GateReceiptPayload = {
    id: receiptId,
    ...identity,
    setup: recordedSetup,
    ...run,
    artifact: { path: relativeExecutionPath, sha256: sha256(executionBytes) },
    sensor,
  };
  const receiptJson = canonicalJson(receipt);
  return {
    receipt,
    receiptJson,
    executionBytes,
    outputs: [
      ...recordedSetupArtifacts.flatMap((step) => [step.stdout, step.stderr]),
      ...[execution.stdout, execution.stderr].filter((item) => item !== null),
    ],
    diagnostic: gateExecution.diagnostic,
  };
}

export function resolveGateWorkingDirectories(repoRoot: string, gate: ProofGate) {
  return {
    gate: resolveProofWorkingDirectory(repoRoot, gate.id, gate.working_directory),
    setup: (gate.setup ?? []).map((step) =>
      resolveProofWorkingDirectory(repoRoot, gate.id, step.working_directory, step.id),
    ),
  };
}

/**
 * `setupStepId` names a declared setup step when the directory being resolved belongs to one, so the error
 * points at the step the operator has to correct rather than at the gate.
 */
export function resolveProofWorkingDirectory(
  repoRoot: string,
  gateId: string,
  workingDirectory: string,
  setupStepId?: string,
) {
  const field = setupStepId
    ? `proof_plan.gates.${gateId}.setup.${setupStepId}.working_directory`
    : `proof_plan.gates.${gateId}.working_directory`;
  const canonicalRepoRoot = realpathSync(repoRoot);
  let gateDirectory: string;
  try {
    gateDirectory = realpathSync(path.resolve(canonicalRepoRoot, workingDirectory));
  } catch {
    throw new ProofValidationError(field, `${field} must name an existing directory.`);
  }
  const relative = path.relative(canonicalRepoRoot, gateDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProofValidationError(field, `${field} resolves outside the repository.`);
  }
  if (!statSync(gateDirectory, { throwIfNoEntry: false })?.isDirectory())
    throw new ProofValidationError(field, `${field} must name a directory.`);
  return gateDirectory;
}

function relativeArtifactPath(repoRoot: string, artifactPath: string) {
  return path.relative(repoRoot, artifactPath).split(path.sep).join('/');
}
