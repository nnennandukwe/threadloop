import type { CommandContext } from './runtime.js';
import { writeCommandSuccess, toSessionId } from './runtime.js';
import { reconcileSession } from '../services/session-service.js';

export type DaemonRunOptions = { interval?: number };

const DEFAULT_INTERVAL_MS = 60000;

export async function daemonRunCommand(context: CommandContext, options: DaemonRunOptions) {
  const interval = options.interval ?? DEFAULT_INTERVAL_MS;
  const stop = new Promise<void>((resolve) => {
    const cleanup = () => {
      process.removeListener('SIGINT', cleanup);
      process.removeListener('SIGTERM', cleanup);
      resolve();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });

  writeCommandSuccess(context, {
    text: [`Daemon started, reconciling every ${interval / 1000}s. Press Ctrl+C to stop.`],
    data: { daemon: 'running', interval_ms: interval },
  });

  while (true) {
    const result = await Promise.race([
      stop,
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, interval));
        return 'tick';
      })(),
    ]);

    if (result !== 'tick') {
      break;
    }

    try {
      const results = await reconcileSession({
        cwd: context.cwd,
        reconcileAll: true,
      });
      process.stdout.write(`[daemon] Reconciled ${results.length} session(s)\n`);
    } catch (error) {
      process.stderr.write(`[daemon] Error: ${error}\n`);
    }
  }

  writeCommandSuccess(context, {
    text: ['Daemon stopped.'],
    data: { daemon: 'stopped' },
  });
}