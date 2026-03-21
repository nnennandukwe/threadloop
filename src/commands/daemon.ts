import type { CommandContext } from './runtime.js';
import { writeCommandSuccess } from './runtime.js';
import { reconcileSession } from '../services/session-service.js';

export type DaemonRunOptions = { interval?: number };
export interface DaemonRunRuntimeOptions {
  stopSignal?: AbortSignal;
  registerProcessSignalHandlers?: boolean;
}

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 1;

function parseIntervalSeconds(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_INTERVAL_SECONDS;
  }
  if (!Number.isFinite(value) || value < MIN_INTERVAL_SECONDS) {
    throw new Error(`Interval must be at least ${MIN_INTERVAL_SECONDS} second`);
  }
  return value;
}

function renderStopInstruction(runtimeOptions: DaemonRunRuntimeOptions): string {
  if (runtimeOptions.registerProcessSignalHandlers ?? true) {
    return ' Press Ctrl+C to stop.';
  }

  if (runtimeOptions.stopSignal) {
    return ' Waiting for stop signal.';
  }

  return '';
}

export async function daemonRunCommand(
  context: CommandContext,
  options: DaemonRunOptions,
  runtimeOptions: DaemonRunRuntimeOptions = {},
) {
  const intervalSeconds = parseIntervalSeconds(options.interval);
  const intervalMs = intervalSeconds * 1000;
  const registerProcessSignalHandlers = runtimeOptions.registerProcessSignalHandlers ?? true;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const stop = new Promise<void>((resolve) => {
    let settled = false;

    const onAbort = () => {
      cleanup();
    };

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;

      if (registerProcessSignalHandlers) {
        process.removeListener('SIGINT', cleanup);
        process.removeListener('SIGTERM', cleanup);
      }
      runtimeOptions.stopSignal?.removeEventListener('abort', onAbort);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      resolve();
    };

    if (registerProcessSignalHandlers) {
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
    }

    if (runtimeOptions.stopSignal?.aborted) {
      cleanup();
      return;
    }

    runtimeOptions.stopSignal?.addEventListener('abort', onAbort);
  });

  writeCommandSuccess(context, {
    text: [`Daemon started, reconciling every ${intervalSeconds}s.${renderStopInstruction(runtimeOptions)}`],
    data: { daemon: 'running', interval_ms: intervalMs },
  });

  const output = context.json ? process.stderr : process.stdout;

  while (true) {
    let tickResolve: (value: 'tick') => void;
    const tickPromise = new Promise<'tick'>((resolve) => {
      tickResolve = resolve;
      timeoutId = setTimeout(() => tickResolve('tick'), intervalMs);
    });

    const result = await Promise.race([stop, tickPromise]);

    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }

    if (result !== 'tick') {
      break;
    }

    try {
      const results = await reconcileSession({
        cwd: context.cwd,
        reconcileAll: true,
      });
      output.write(`[daemon] Reconciled ${results.length} session(s)\n`);
    } catch (error) {
      process.stderr.write(`[daemon] Error: ${error}\n`);
    }
  }

  writeCommandSuccess(context, {
    text: ['Daemon stopped.'],
    data: { daemon: 'stopped' },
  });
}
