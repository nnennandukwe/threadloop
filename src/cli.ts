#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { artifactGenerateCommand } from './commands/artifact.js';
import { captureCommand } from './commands/capture.js';
import { initCommand } from './commands/init.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { sessionStartCommand } from './commands/session-start.js';
import { sessionListCommand } from './commands/session-list.js';
import { sessionStatusCommand } from './commands/session-status.js';
import { sessionCaptureCommand } from './commands/session-capture.js';
import { sessionHeartbeatCommand } from './commands/session-heartbeat.js';
import { sessionTransitionCommand } from './commands/session-transition.js';
import { sessionNextCommand } from './commands/session-next.js';
import { sessionReconcileCommand } from './commands/session-reconcile.js';
import { daemonRunCommand } from './commands/daemon.js';
import { protocolPrintCommand } from './commands/protocol.js';
import { createInvalidArgumentError, toThreadloopError } from './contracts/errors.js';
import { renderCommandFailure } from './contracts/output.js';
import { createCommandContext } from './commands/runtime.js';
import { createThreadloopProgram } from './cli-program.js';

const program = createThreadloopProgram({
  init: run(initCommand),
  start: commandAction('start', startCommand),
  capture: commandAction('capture', captureCommand),
  status: commandAction('status', statusCommand),
  artifactGenerate: commandAction('artifact generate', artifactGenerateCommand),
  sessionStart: commandAction('session start', sessionStartCommand),
  sessionList: commandAction('session list', sessionListCommand),
  sessionStatus: commandAction('session status', sessionStatusCommand),
  sessionCapture: commandAction('session capture', sessionCaptureCommand),
  sessionHeartbeat: commandAction('session heartbeat', sessionHeartbeatCommand),
  sessionTransition: commandAction('session transition', sessionTransitionCommand),
  sessionNext: commandAction('session next', sessionNextCommand),
  sessionReconcile: commandAction('session reconcile', sessionReconcileCommand),
  daemonRun: commandAction('daemon run', daemonRunCommand),
  protocol: commandAction('protocol', protocolPrintCommand),
});

program.parseAsync(process.argv).catch(handleError);

function run<T extends unknown[]>(handler: (...args: T) => Promise<void>) {
  return (...args: T) => handler(...args).catch(handleError);
}

function commandAction<T extends unknown[]>(
  commandName: string,
  handler: (context: ReturnType<typeof createCommandContext>, ...args: T) => void | Promise<void>,
) {
  return (...args: [...T, Command]) => {
    const command = args.at(-1);
    if (!(command instanceof Command)) {
      throw createInvalidArgumentError('ThreadLoop could not determine the invoked command context.');
    }

    return Promise.resolve(handler(createCommandContext(commandName, command), ...(args.slice(0, -1) as T))).catch(
      handleError,
    );
  };
}

function handleError(error: unknown) {
  if (
    error instanceof CommanderError &&
    (error.code === 'commander.version' || error.code === 'commander.help' || error.code.startsWith('commander.help'))
  ) {
    process.exitCode = 0;
    return;
  }

  const json = process.argv.includes('--json');
  const command = detectInvokedCommand(process.argv.slice(2));
  const threadloopError =
    error instanceof CommanderError
      ? createInvalidArgumentError(error.message, { commander_code: error.code })
      : toThreadloopError(error);

  process.stderr.write(
    `${renderCommandFailure(
      command,
      {
        code: threadloopError.code,
        message: threadloopError.message,
        ...(threadloopError.details ? { details: threadloopError.details } : {}),
      },
      json,
    )}\n`,
  );
  process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
}

function detectInvokedCommand(argv: string[]) {
  const tokens = argv.filter((token) => token !== '--json');
  if (tokens[0] === 'session' && tokens[1]) {
    return `session ${tokens[1]}`;
  }

  if (tokens[0] === 'artifact' && tokens[1] === 'generate') {
    return 'artifact generate';
  }

  return tokens[0] ?? 'threadloop';
}
