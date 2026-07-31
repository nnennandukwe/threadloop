import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { GateReceiptResult } from '../../domain/proof.js';

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
}

export interface GateSetupStepInput extends GateProcessInput {
  id: string;
}

/** One declared setup step as it actually ran, including the observations taken around it. */
export interface SetupStepExecution {
  id: string;
  command: string[];
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
}

/**
 * Runs every declared setup step in order and then the gate command. The single execution path shared by
 * `session gate run` and the CI sensor, so a local receipt and a signed receipt for the same HEAD cannot
 * describe setup differently.
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
      return { setup, gate: null, observedAfter: null };
    }
    const process = await runGateProcess(step);
    const stepAfter = await input.observe();
    setup.push({
      id: step.id,
      command: step.command,
      timeoutMs: step.timeoutMs,
      process,
      headBefore: stepBefore.headSha,
      headAfter: stepAfter?.headSha ?? stepBefore.headSha,
      cleanBefore: stepBefore.clean,
      cleanAfter: stepAfter?.clean ?? false,
    });
    observed = stepAfter;

    if (process.result !== 'passed' || !stepAfter || !stepAfter.clean || stepAfter.headSha !== stepBefore.headSha) {
      return { setup, gate: null, observedAfter: stepAfter };
    }
  }

  const gate = await runGateProcess(input.gate);
  return { setup, gate, observedAfter: await input.observe() };
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
  const child = spawn(executable, args, {
    cwd: input.cwd,
    shell: false,
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

  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    if (!child.kill('SIGTERM')) {
      cleanupFailed = true;
    }
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && !child.kill('SIGKILL')) {
        cleanupFailed = true;
      }
    }, 2_000);
    forceTimer.unref();
  };

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
