import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { canonicalExecutorJson, validateExecutorRequest, type ExecutorRequest } from 'threadloop-contracts/executor';
import { GaapEvidenceError } from '../../domain/gaap-json.js';

export interface GaapProcessInput {
  executable: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  request: ExecutorRequest;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}
export interface GaapProcessResult {
  status:
    | 'ok'
    | 'timeout'
    | 'cancelled'
    | 'exit_failed'
    | 'spawn_failed'
    | 'input_failed'
    | 'output_limit'
    | 'io_failed'
    | 'cleanup_failed';
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  finishedAt: string;
  inputDelivered: boolean;
  error: string | null;
}

/** One shell-free invocation; bounded raw output is recovery evidence, never a successful receipt. */
export async function runGaapProcess(input: GaapProcessInput): Promise<GaapProcessResult> {
  if (process.platform === 'win32')
    throw new GaapEvidenceError(
      'process.platform',
      'The GAAP process adapter currently requires POSIX process-group cleanup.',
    );
  if (
    !path.isAbsolute(input.executable) ||
    !path.isAbsolute(input.cwd) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 300_000
  )
    throw new GaapEvidenceError(
      'process.config',
      'Select absolute executable/workspace paths and a timeout between 1 and 300000 milliseconds.',
    );
  const deadline = performance.now() + input.timeoutMs;
  const request = validateExecutorRequest(input.request);
  if (!request.ok)
    throw new GaapEvidenceError('process.request', request.diagnostics.map((item) => item.message).join(' '));
  const encoded = canonicalExecutorJson(request.value);
  if (!encoded.ok)
    throw new GaapEvidenceError(
      'process.request',
      'The executor request cannot be encoded by the frozen process codec.',
    );
  const startedAt = new Date().toISOString();
  if (input.abortSignal?.aborted)
    return {
      status: 'cancelled',
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: null,
      signal: null,
      startedAt,
      finishedAt: startedAt,
      inputDelivered: false,
      error: 'Authority was cancelled before launch.',
    };
  if (performance.now() >= deadline)
    return {
      status: 'timeout',
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: null,
      signal: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      inputDelivered: false,
      error: 'The process deadline expired while preparing the request.',
    };
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(input.executable, [...input.arguments], {
        cwd: input.cwd,
        env: { ...input.environment },
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (cause) {
      resolve({
        status: 'spawn_failed',
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        exitCode: null,
        signal: null,
        startedAt,
        finishedAt: new Date().toISOString(),
        inputDelivered: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    let status: GaapProcessResult['status'] = 'ok';
    let error: string | null = null;
    let inputDelivered = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let finished = false;
    let cleanupError: string | null = null;
    let forceTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const limits = { stdout: 16 * 1024 * 1024 + 1, stderr: 64 * 1024 };
    const signalGroup = (value: NodeJS.Signals): boolean => {
      if (child.pid === undefined) return true;
      try {
        process.kill(-child.pid, value);
        return true;
      } catch (cause) {
        return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ESRCH';
      }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      clearTimeout(drainTimer);
      input.abortSignal?.removeEventListener('abort', abort);
      if (cleanupError !== null) {
        status = 'cleanup_failed';
        error = cleanupError;
      }
      if (status === 'ok' && !inputDelivered) {
        status = 'input_failed';
        error = 'The complete request and EOF were not delivered.';
      }
      if (status === 'ok' && (exitCode !== 0 || signal !== null)) status = 'exit_failed';
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({
        status,
        stdout: Buffer.concat(output.stdout),
        stderr: Buffer.concat(output.stderr),
        exitCode,
        signal,
        startedAt,
        finishedAt: new Date().toISOString(),
        inputDelivered,
        error,
      });
    };
    const boundedDrain = () => {
      drainTimer ??= setTimeout(() => {
        status = 'cleanup_failed';
        error =
          'The process or its output pipes did not stop within the cleanup deadline. Retain evidence and reconcile this Attempt before retrying.';
        signalGroup('SIGKILL');
        finish();
      }, 500);
    };
    const terminate = (reason: GaapProcessResult['status'], message: string) => {
      if (finished) return;
      if (status === 'ok') {
        status = reason;
        error = message;
      }
      if (!signalGroup('SIGTERM')) {
        cleanupError = 'The controlled process group could not be signalled. Reconcile before retrying.';
      }
      forceTimer ??= setTimeout(() => {
        if (!signalGroup('SIGKILL')) {
          cleanupError = 'The controlled process group could not be stopped. Reconcile before retrying.';
        }
      }, 100);
      boundedDrain();
    };
    const abort = () => terminate('cancelled', 'Authority was cancelled during execution.');
    const timeout = setTimeout(
      () => terminate('timeout', 'The GAAP process exceeded its authority or runtime deadline.'),
      Math.max(1, deadline - performance.now()),
    );
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        if (finished) return;
        const available = Math.max(0, limits[stream] - sizes[stream]);
        if (available > 0) output[stream].push(Buffer.from(chunk.subarray(0, available)));
        sizes[stream] += chunk.length;
        if (sizes[stream] > limits[stream])
          terminate('output_limit', `The GAAP process exceeded its ${stream} byte limit.`);
      });
      child[stream].on('error', (cause: Error) => terminate('io_failed', cause.message));
    }
    child.stdin.on('finish', () => {
      inputDelivered = true;
    });
    child.stdin.on('error', (cause: Error) => terminate('input_failed', cause.message));
    child.once('error', (cause: Error) => {
      if (status === 'ok') status = 'spawn_failed';
      error = error === null ? cause.message : error + ' ' + cause.message;
      boundedDrain();
    });
    child.once('exit', (code, value) => {
      exitCode = code;
      signal = value;
      // A successful leader exit must also stop descendants holding the workspace or transport open.
      if (!signalGroup('SIGKILL')) {
        cleanupError = 'A descendant could not be stopped. Reconcile before retrying.';
      } else {
        // macOS can report EPERM while an EPIPE-producing leader is exiting.
        // Successful final group cleanup settles that transient signal error.
        cleanupError = null;
      }
      boundedDrain();
    });
    child.once('close', finish);
    input.abortSignal?.addEventListener('abort', abort, { once: true });
    // An abort can race registration after the initial check.
    if (input.abortSignal?.aborted) abort();
    child.stdin.end(Buffer.from(encoded.value));
  });
}
