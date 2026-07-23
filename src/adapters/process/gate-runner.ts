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
    env: process.env,
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
