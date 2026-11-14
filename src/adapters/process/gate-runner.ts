import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { GateReceiptResult, RecordedSetupStep } from '../../domain/proof.js';

export interface GateProcessInput {
  command: string[];
  cwd: string;
  timeoutMs: number;
  stdoutPath: string;
  stderrPath: string;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
}

export interface GateOutputDigest {
  sha256: string;
  bytes: number;
}

export interface GateProcessResult {
  result: GateReceiptResult;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  stdout: GateOutputDigest;
  stderr: GateOutputDigest;
  error: { name: string; message: string; code?: string } | null;
}

/** The subset of a repository observation that gate execution depends on. */
export interface GateRepositoryObservation {
  headSha: string;
  clean: boolean;
  changedFiles: string[];
  /** Present when the caller also binds execution to a branch; CI binds only the caller SHA. */
  branch?: string | null;
}

export interface RepositoryMutationDiagnostic {
  code: 'SETUP_MUTATED_REPOSITORY' | 'GATE_MUTATED_REPOSITORY' | 'REPOSITORY_ALREADY_DIRTY';
  message: string;
  step_id: string | null;
  changed_files: string[];
  hint: string;
}

export interface GateSetupStepInput extends GateProcessInput {
  id: string;
  /** The declared repository-relative directory. Recorded on the receipt, unlike the resolved absolute `cwd`. */
  workingDirectory: string;
}

/** One declared setup step as it actually ran, including the observations taken around it. */
export interface SetupStepExecution {
  id: string;
  command: string[];
  workingDirectory: string;
  timeoutMs: number;
  process: GateProcessResult;
  headBefore: string;
  headAfter: string;
  cleanBefore: boolean;
  cleanAfter: boolean;
}

export interface GateWithSetupInput {
  setup: readonly GateSetupStepInput[];
  gate: GateProcessInput;
  observedBefore: GateRepositoryObservation;
  /** Returns null when the observation itself failed, which is treated as a compromised repository. */
  observe: () => Promise<GateRepositoryObservation | null>;
}

export interface GateWithSetupResult {
  setup: SetupStepExecution[];
  /** Null when a setup step short-circuited the sequence, so the gate command never ran. */
  gate: GateProcessResult | null;
  observedAfter: GateRepositoryObservation | null;
  /** Transient operator guidance. It's kept outside the persisted receipt contract. */
  diagnostic: RepositoryMutationDiagnostic | null;
  /**
   * Spans everything that actually ran, from the first process started to the last one that ended. A gate
   * blocked by failing setup still reports the real duration of the setup that was attempted.
   */
  window: {
    startedAt: string;
    endedAt: string;
    durationMs: number;
  };
}

/**
 * Runs every declared setup step in order and then the gate command. Local and CI execution share the same
 * runner and receipt serialization while applying their existing repository bindings: local observations
 * include the bound branch, while CI observations bind only the caller SHA.
 *
 * A setup step that does not pass stops the sequence: remaining steps and the gate command do not run. A
 * compromised repository observation stops it too, because continuing would attribute later work to a HEAD
 * that is no longer the one being verified.
 */
export async function runGateWithSetup(input: GateWithSetupInput): Promise<GateWithSetupResult> {
  const setup: SetupStepExecution[] = [];
  let observed: GateRepositoryObservation | null = input.observedBefore;

  for (const step of input.setup) {
    const stepBefore = observed;
    if (!stepBefore) {
      return { setup, gate: null, observedAfter: null, diagnostic: null, window: executionWindow(setup, null) };
    }
    const process = await runGateProcess(step);
    const stepAfter = await input.observe();
    setup.push({
      id: step.id,
      command: step.command,
      workingDirectory: step.workingDirectory,
      timeoutMs: step.timeoutMs,
      process,
      headBefore: stepBefore.headSha,
      headAfter: stepAfter?.headSha ?? stepBefore.headSha,
      cleanBefore: stepBefore.clean,
      cleanAfter: stepAfter?.clean ?? false,
    });
    observed = stepAfter;
    const diagnostic = repositoryMutationDiagnostic('setup', step.id, stepBefore, stepAfter);

    if (
      process.result !== 'passed' ||
      !stepAfter ||
      !stepAfter.clean ||
      stepAfter.headSha !== stepBefore.headSha ||
      repositoryBranchChanged(stepBefore, stepAfter)
    ) {
      return { setup, gate: null, observedAfter: stepAfter, diagnostic, window: executionWindow(setup, null) };
    }
  }

  if (!observed) {
    throw new Error('Gate execution lost its repository observation before the gate started.');
  }
  const gate = await runGateProcess(input.gate);
  const observedAfter = await input.observe();
  return {
    setup,
    gate,
    observedAfter,
    diagnostic: repositoryMutationDiagnostic('gate', null, observed, observedAfter),
    window: executionWindow(setup, gate),
  };
}

function repositoryMutationDiagnostic(
  actor: 'setup' | 'gate',
  stepId: string | null,
  before: GateRepositoryObservation,
  after: GateRepositoryObservation | null,
): RepositoryMutationDiagnostic | null {
  if (!after) {
    return null;
  }

  // A dirty CI baseline can contain unrelated paths. Only newly dirty paths can be attributed from status alone.
  const previouslyDirty = new Set(before.changedFiles);
  const changedFiles = after.changedFiles.filter((file) => !previouslyDirty.has(file)).sort();
  const headChanged = before.headSha !== after.headSha;
  const branchChanged = repositoryBranchChanged(before, after);
  const subject = actor === 'setup' ? `Setup step ${stepId}` : 'Gate command';
  if (!headChanged && !branchChanged && changedFiles.length === 0) {
    if (!before.clean && !after.clean) {
      const baselinePaths = diagnosticPathSummary([...before.changedFiles].sort());
      return {
        code: 'REPOSITORY_ALREADY_DIRTY',
        message: `${subject} ran with an already-dirty repository${before.changedFiles.length > 0 ? `: ${baselinePaths.text}` : ''}. Git status can't attribute edits to those existing dirty paths.`,
        step_id: stepId,
        changed_files: [],
        hint: 'Restore or commit the pre-existing dirty paths (use git status --short --untracked-files=all for the current list), then start a new session from a clean repository.',
      };
    }
    return null;
  }
  const timing = actor === 'setup' ? 'before the gate ran' : 'while it ran';
  const pathSummary = diagnosticPathSummary(changedFiles);
  const paths = changedFiles.length > 0 ? `: ${pathSummary.text}` : '';
  const branchDetail = branchChanged
    ? ` (branch changed from ${quoteDiagnosticValue(before.branch ?? '(detached HEAD)')} to ${quoteDiagnosticValue(after.branch ?? '(detached HEAD)')})`
    : '';
  const detail = `${paths}${headChanged ? ' (HEAD changed)' : ''}${branchDetail}`;
  const verificationTarget = [
    headChanged ? `the intended verification HEAD ${before.headSha}` : null,
    branchChanged
      ? before.branch === null
        ? 'detached HEAD'
        : `branch ${quoteDiagnosticValue(before.branch ?? '(detached HEAD)')}`
      : null,
  ]
    .filter(Boolean)
    .join(' and ');
  const affectedPaths = !before.clean
    ? 'all dirty paths (use git status --short --untracked-files=all for the full list)'
    : pathSummary.shortened
      ? 'all affected paths (use git status --short --untracked-files=all for the full list)'
      : 'the listed paths';
  const restoration = verificationTarget
    ? `${changedFiles.length > 0 || !before.clean ? `Restore or commit ${affectedPaths} and restore` : 'Restore'} ${verificationTarget}`
    : `Restore or commit ${affectedPaths}`;
  const prevention =
    headChanged || branchChanged
      ? `change the ${actor === 'setup' ? 'setup declaration' : 'gate'} so it preserves ${branchChanged ? 'HEAD and the bound branch' : 'HEAD'} and writes only to gitignored paths or outside the repository`
      : actor === 'setup'
        ? 'change the setup declaration to use a frozen installer and gitignored output'
        : 'change the gate to write generated output outside the repository or to gitignored paths';

  return {
    code: actor === 'setup' ? 'SETUP_MUTATED_REPOSITORY' : 'GATE_MUTATED_REPOSITORY',
    message: `${subject} changed the repository ${timing}${detail}.`,
    step_id: stepId,
    changed_files: changedFiles,
    hint: `${restoration}, ${prevention}, then start a new session.`,
  };
}

function diagnosticPathSummary(paths: readonly string[]): { text: string; shortened: boolean } {
  const displayed = paths.slice(0, 5).map((file) => {
    const characters = Array.from(file);
    const shortened = characters.length > 80;
    return {
      value: quoteDiagnosticValue(shortened ? `${characters.slice(0, 80).join('')}...` : file),
      shortened,
    };
  });
  const shortenedNames = displayed.some((file) => file.shortened);
  const shortened = displayed.length < paths.length || shortenedNames;
  const count = shortened
    ? ` (${displayed.length} of ${paths.length} paths shown${shortenedNames ? '; long paths shortened' : ''})`
    : '';
  return { text: `${displayed.map((file) => file.value).join(', ')}${count}`, shortened };
}

function quoteDiagnosticValue(value: string): string {
  // Keep raw paths in changed_files, but prevent terminal controls and visual reordering in human-readable logs.
  // Escape UTF-16 units so astral format characters retain both halves of their surrogate pair.
  return JSON.stringify(value).replace(/\p{Cc}|\p{Cf}|[\u2028\u2029]/gu, (character) =>
    character
      .split('')
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  );
}

function repositoryBranchChanged(before: GateRepositoryObservation, after: GateRepositoryObservation): boolean {
  return before.branch !== undefined && after.branch !== undefined && before.branch !== after.branch;
}

/**
 * Preserves any compromised observation from the shared execution window, even if a caller's later final
 * observation succeeds.
 */
export function gateExecutionWasInvalidated(
  execution: Pick<GateWithSetupResult, 'setup' | 'observedAfter'>,
  observedBefore: GateRepositoryObservation,
): boolean {
  const observedAfter = execution.observedAfter;
  return (
    !observedAfter ||
    !observedAfter.clean ||
    observedAfter.headSha !== observedBefore.headSha ||
    repositoryBranchChanged(observedBefore, observedAfter) ||
    execution.setup.some(
      (step) =>
        !step.cleanBefore ||
        !step.cleanAfter ||
        step.headBefore !== observedBefore.headSha ||
        step.headAfter !== observedBefore.headSha,
    )
  );
}

function executionWindow(setup: readonly SetupStepExecution[], gate: GateProcessResult | null) {
  // Either the gate ran, or at least one setup step ran to have blocked it, so this is never empty.
  const processes = [...setup.map((step) => step.process), ...(gate ? [gate] : [])];
  const first = processes[0];
  const last = processes[processes.length - 1];
  if (!first || !last) {
    throw new Error('Gate execution produced no process to describe.');
  }
  return {
    startedAt: first.startedAt,
    endedAt: last.endedAt,
    durationMs: Math.max(0, Date.parse(last.endedAt) - Date.parse(first.startedAt)),
  };
}

/**
 * Serializes an executed setup step into its receipt form. Shared by both execution paths so a local receipt
 * and a signed receipt cannot describe the same step with different fields.
 */
export function toRecordedSetupStep(execution: SetupStepExecution): RecordedSetupStep {
  return {
    id: execution.id,
    command: execution.command,
    working_directory: execution.workingDirectory,
    timeout_ms: execution.timeoutMs,
    result: execution.process.result,
    started_at: execution.process.startedAt,
    ended_at: execution.process.endedAt,
    duration_ms: execution.process.durationMs,
    exit_status: execution.process.exitStatus,
    signal: execution.process.signal,
    head_before: execution.headBefore,
    head_after: execution.headAfter,
    clean_before: execution.cleanBefore,
    clean_after: execution.cleanAfter,
    output: {
      stdout_sha256: execution.process.stdout.sha256,
      stderr_sha256: execution.process.stderr.sha256,
    },
  };
}

/**
 * Maps a recorded execution to the gate result that goes on the receipt. The one place the precedence
 * between repository invalidation, setup failure, and the gate's own outcome is decided, so the local and CI
 * paths cannot classify the same execution differently.
 *
 * `invalidated` is supplied by the caller because each path compares its own notion of an unchanged
 * repository: the local path also requires the bound branch, the CI path also requires the caller SHA.
 *
 * Every non-passing setup outcome collapses to one `setup_failed`. The distinction between a step that timed
 * out and one that exited non-zero lives in the recorded step itself, so the receipt keeps it without adding
 * a contract value that consumers would have to pin against.
 */
export function classifyGateOutcome(input: {
  setup: readonly SetupStepExecution[];
  gate: GateProcessResult | null;
  invalidated: boolean;
}): GateReceiptResult {
  // Evidence integrity outranks classification: a receipt must never claim to describe a HEAD it does not.
  if (input.invalidated) {
    return 'invalidated';
  }
  if (input.setup.some((step) => step.process.result !== 'passed')) {
    return 'setup_failed';
  }
  // Setup passed, so the sequence should have reached the gate. A missing gate result means execution broke
  // rather than that the gate passed.
  return input.gate?.result ?? 'execution_error';
}

export async function runGateProcess(input: GateProcessInput): Promise<GateProcessResult> {
  const [executable, ...args] = input.command;
  if (!executable) {
    throw new Error('Gate command must include an executable.');
  }

  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const stdoutDigest = new DigestTransform();
  const stderrDigest = new DigestTransform();
  const stdoutWrite = createWriteStream(input.stdoutPath, { flags: 'wx' });
  const stderrWrite = createWriteStream(input.stderrPath, { flags: 'wx' });
  // The gate leads its own process group so a timeout or abort can terminate everything it started. Signalling
  // only the direct child would leave a grandchild holding the output pipes, and the gate would outlive its
  // timeout until that grandchild exited.
  const ownsProcessGroup = process.platform !== 'win32';
  const child = spawn(executable, args, {
    cwd: input.cwd,
    shell: false,
    detached: ownsProcessGroup,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: input.env ?? process.env,
  });
  const stdoutPipeline = settlePipeline(pipeline(child.stdout, stdoutDigest, stdoutWrite));
  const stderrPipeline = settlePipeline(pipeline(child.stderr, stderrDigest, stderrWrite));

  let timedOut = false;
  let aborted = false;
  let cleanupFailed = false;
  let processError: NodeJS.ErrnoException | null = null;
  let forceTimer: NodeJS.Timeout | undefined;

  /** Signals the gate's process tree. Returns false only when a live tree could not be signalled. */
  const signalGate = (signal: NodeJS.Signals) => {
    if (!ownsProcessGroup || child.pid === undefined) {
      return child.kill(signal) || child.exitCode !== null || child.signalCode !== null;
    }
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      // ESRCH: every process in the group has already exited, so there is nothing left to terminate.
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };

  const terminate = () => {
    if (forceTimer) {
      return;
    }
    if (!signalGate('SIGTERM')) {
      cleanupFailed = true;
    }
    forceTimer = setTimeout(() => {
      if (!signalGate('SIGKILL')) {
        cleanupFailed = true;
      }
    }, 2_000);
    forceTimer.unref();
  };

  // A detached gate no longer shares the terminal's process group, so an interrupt aimed at ThreadLoop would
  // not reach it. Forward the signal to the gate's tree, then re-raise it so ThreadLoop exits exactly as it
  // would have without the handler.
  const forwardedSignals = ownsProcessGroup ? (['SIGINT', 'SIGTERM', 'SIGHUP'] as const) : [];
  const removeSignalForwarding = () => {
    for (const signal of forwardedSignals) {
      process.removeListener(signal, forwardSignal);
    }
  };
  function forwardSignal(signal: NodeJS.Signals) {
    signalGate(signal);
    removeSignalForwarding();
    process.kill(process.pid, signal);
  }
  for (const signal of forwardedSignals) {
    process.once(signal, forwardSignal);
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, input.timeoutMs);
  timeout.unref();

  const onAbort = () => {
    aborted = true;
    terminate();
  };
  input.abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (input.abortSignal?.aborted) {
    onAbort();
  }

  child.once('error', (error) => {
    processError = error;
  });
  const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  clearTimeout(timeout);
  if (forceTimer) {
    clearTimeout(forceTimer);
  }
  removeSignalForwarding();
  input.abortSignal?.removeEventListener('abort', onAbort);
  const streamResults = await Promise.all([stdoutPipeline, stderrPipeline]);
  const streamError = streamResults.find((result) => !result.ok);
  if (streamError && !streamError.ok) {
    cleanupFailed = true;
    if (!processError && streamError.error instanceof Error) {
      processError = streamError.error;
    }
  }

  const ended = Date.now();
  let result: GateReceiptResult;
  if (cleanupFailed) {
    result = 'cleanup_failed';
  } else if (aborted) {
    result = 'aborted';
  } else if (timedOut) {
    result = 'timed_out';
  } else if (processError) {
    result = 'execution_error';
  } else {
    result = close.code === 0 ? 'passed' : 'failed';
  }

  return {
    result,
    startedAt,
    endedAt: new Date(ended).toISOString(),
    durationMs: Math.max(0, ended - started),
    exitStatus: close.code,
    signal: close.signal,
    stdout: stdoutDigest.finish(),
    stderr: stderrDigest.finish(),
    error: processError
      ? {
          name: processError.name,
          message: processError.message,
          ...(typeof processError.code === 'string' ? { code: processError.code } : {}),
        }
      : null,
  };
}

function settlePipeline(pipelinePromise: Promise<void>) {
  return pipelinePromise.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

class DigestTransform extends Transform {
  readonly hash = createHash('sha256');
  bytes = 0;
  finished = false;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ) {
    this.hash.update(chunk);
    this.bytes += chunk.byteLength;
    callback(null, chunk);
  }

  finish(): GateOutputDigest {
    if (this.finished) {
      throw new Error('Gate output digest was already finalized.');
    }
    this.finished = true;
    return { sha256: this.hash.digest('hex'), bytes: this.bytes };
  }
}
