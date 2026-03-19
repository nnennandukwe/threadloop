#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { ARTIFACT_KINDS, ENTRY_KINDS, HEARTBEAT_SOURCES } from './domain/types.js';
import { artifactGenerateCommand } from './commands/artifact.js';
import { captureCommand } from './commands/capture.js';
import { finishCommand } from './commands/finish.js';
import { initCommand } from './commands/init.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';
import { sessionStartCommand } from './commands/session-start.js';
import { sessionListCommand } from './commands/session-list.js';
import { sessionStatusCommand } from './commands/session-status.js';
import { sessionCaptureCommand } from './commands/session-capture.js';
import { sessionHeartbeatCommand } from './commands/session-heartbeat.js';
import { sessionFinishCommand } from './commands/session-finish.js';
import { createInvalidArgumentError, toThreadloopError } from './contracts/errors.js';
import { renderCommandFailure } from './contracts/output.js';
import { createCommandContext } from './commands/runtime.js';

const program = new Command();

function parseEntryKind(value: string) {
  if (!ENTRY_KINDS.includes(value as (typeof ENTRY_KINDS)[number])) {
    throw new InvalidArgumentError(`Entry kind must be one of: ${ENTRY_KINDS.join(', ')}`);
  }
  return value as (typeof ENTRY_KINDS)[number];
}

function parseArtifactKind(value: string) {
  if (!ARTIFACT_KINDS.includes(value as (typeof ARTIFACT_KINDS)[number])) {
    throw new InvalidArgumentError(`Artifact kind must be one of: ${ARTIFACT_KINDS.join(', ')}`);
  }
  return value as (typeof ARTIFACT_KINDS)[number];
}

function parseHeartbeatSource(value: string) {
  if (!HEARTBEAT_SOURCES.includes(value as (typeof HEARTBEAT_SOURCES)[number])) {
    throw new InvalidArgumentError(`Heartbeat source must be one of: ${HEARTBEAT_SOURCES.join(', ')}`);
  }
  return value as (typeof HEARTBEAT_SOURCES)[number];
}

function withJsonOption<T extends Command>(command: T) {
  return command.addOption(new Option('--json', 'Output machine-readable JSON'));
}

program
  .name('threadloop')
  .description('Task-first, repo-local session memory that generates review-ready artifacts')
  .version('0.1.0')
  .showHelpAfterError(false)
  .configureOutput({
    writeOut: (text) => process.stdout.write(text),
    writeErr: () => {},
  })
  .exitOverride();

program.command('init').description('Initialize ThreadLoop in the current Git repo').action(run(initCommand));

withJsonOption(
  program
    .command('start')
    .description('Start a task-scoped session')
    .argument('<title>', 'task title')
    .option('--goal <goal>', 'goal for the task')
    .option('--constraint <constraint...>', 'constraints that matter for this task')
    .option('--base <ref>', 'base Git ref used for comparisons')
    .option('--goal-edit', 'open $EDITOR for the goal text'),
).action(commandAction('start', startCommand));

withJsonOption(
  program
    .command('capture')
    .description('Capture a structured checkpoint entry')
    .argument('<kind>', 'entry kind', parseEntryKind)
    .argument('[text]', 'entry text')
    .option('--session <id>', 'session id to target')
    .option('--because <reason>', 'optional reasoning or context')
    .option('--edit', 'open $EDITOR for longer text'),
).action(commandAction('capture', captureCommand));

withJsonOption(
  program.command('status').description('Show the current task/session status').option('--session <id>', 'session id to target'),
).action(commandAction('status', statusCommand));

const artifact = program.command('artifact').description('Generate artifacts from session context');
withJsonOption(
  artifact
    .command('generate')
    .description('Generate a Markdown artifact from task, notes, and Git context')
    .argument('[kind]', 'artifact kind', parseArtifactKind, 'change-brief')
    .option('--session <id>', 'session id to target'),
).action(commandAction('artifact generate', artifactGenerateCommand));

withJsonOption(
  program.command('finish').description('Complete the active session').option('--session <id>', 'session id to target'),
).action(commandAction('finish', finishCommand));

const session = program.command('session').description('Manage explicit ThreadLoop sessions');

withJsonOption(
  session
    .command('start')
    .description('Start a task-scoped session')
    .argument('<title>', 'task title')
    .option('--goal <goal>', 'goal for the task')
    .option('--constraint <constraint...>', 'constraints that matter for this task')
    .option('--base <ref>', 'base Git ref used for comparisons')
    .option('--goal-edit', 'open $EDITOR for the goal text'),
).action(commandAction('session start', sessionStartCommand));

withJsonOption(session.command('list').description('List sessions in the current workspace')).action(
  commandAction('session list', sessionListCommand),
);

withJsonOption(
  session.command('status').description('Show status for an explicit session').option('--session <id>', 'session id to target'),
).action(commandAction('session status', sessionStatusCommand));

withJsonOption(
  session
    .command('capture')
    .description('Capture a structured checkpoint entry for an explicit session')
    .argument('<kind>', 'entry kind', parseEntryKind)
    .argument('[text]', 'entry text')
    .option('--session <id>', 'session id to target')
    .option('--because <reason>', 'optional reasoning or context')
    .option('--edit', 'open $EDITOR for longer text'),
).action(commandAction('session capture', sessionCaptureCommand));

withJsonOption(
  session
    .command('heartbeat')
    .description('Refresh mechanical session metadata without creating a semantic entry')
    .option('--session <id>', 'session id to target')
    .option('--source <source>', 'heartbeat source', parseHeartbeatSource),
).action(commandAction('session heartbeat', sessionHeartbeatCommand));

withJsonOption(
  session.command('finish').description('Finish an explicit session').option('--session <id>', 'session id to target'),
).action(commandAction('session finish', sessionFinishCommand));

program.parseAsync(process.argv).catch(handleError);

function run<T extends unknown[]>(handler: (...args: T) => Promise<void>) {
  return (...args: T) => handler(...args).catch(handleError);
}

function commandAction<T extends unknown[]>(
  commandName: string,
  handler: (context: ReturnType<typeof createCommandContext>, ...args: T) => Promise<void>,
) {
  return (...args: [...T, Command]) => {
    const command = args.at(-1);
    if (!(command instanceof Command)) {
      throw createInvalidArgumentError('ThreadLoop could not determine the invoked command context.');
    }

    return handler(createCommandContext(commandName, command), ...(args.slice(0, -1) as T)).catch(handleError);
  };
}

function handleError(error: unknown) {
  if (error instanceof CommanderError && (error.code === 'commander.help' || error.code === 'commander.version')) {
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
        details: threadloopError.details,
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
