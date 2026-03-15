#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { ARTIFACT_KINDS, ENTRY_KINDS } from './domain/types.js';
import { artifactGenerateCommand } from './commands/artifact.js';
import { captureCommand } from './commands/capture.js';
import { finishCommand } from './commands/finish.js';
import { initCommand } from './commands/init.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';

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

program
  .name('threadloop')
  .description('Task-first, repo-local session memory that generates review-ready artifacts')
  .version('0.1.0');

program.command('init').description('Initialize ThreadLoop in the current Git repo').action(run(initCommand));

program
  .command('start')
  .description('Start a task-scoped session')
  .argument('<title>', 'task title')
  .option('--goal <goal>', 'goal for the task')
  .option('--constraint <constraint...>', 'constraints that matter for this task')
  .option('--base <ref>', 'base Git ref used for comparisons')
  .option('--goal-edit', 'open $EDITOR for the goal text')
  .action(run(startCommand));

program
  .command('capture')
  .description('Capture a structured checkpoint entry')
  .argument('<kind>', 'entry kind', parseEntryKind)
  .argument('[text]', 'entry text')
  .option('--because <reason>', 'optional reasoning or context')
  .option('--edit', 'open $EDITOR for longer text')
  .action(run(captureCommand));

program.command('status').description('Show the current task/session status').action(run(statusCommand));

const artifact = program.command('artifact').description('Generate artifacts from session context');
artifact
  .command('generate')
  .description('Generate a Markdown artifact from task, notes, and Git context')
  .argument('[kind]', 'artifact kind', parseArtifactKind, 'change-brief')
  .action(run(artifactGenerateCommand));

program.command('finish').description('Complete the active session').action(run(finishCommand));

program.parseAsync(process.argv).catch(handleError);

function run<T extends unknown[]>(handler: (...args: T) => Promise<void>) {
  return (...args: T) => handler(...args).catch(handleError);
}

function handleError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`threadloop: ${message}`);
  process.exitCode = 1;
}
