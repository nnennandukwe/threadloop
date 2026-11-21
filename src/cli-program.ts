import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { artifactGenerateCommand } from './commands/artifact.js';
import {
  auditCorpusCommand,
  auditExportCommand,
  auditShowCommand,
  auditVerifyCommand,
  auditVerifyExportCommand,
} from './commands/audit.js';
import { initCommand } from './commands/init.js';
import {
  workflowCreateCommand,
  workflowInspectCommand,
  workflowDecideCommand,
  workflowApplyCommand,
  workflowExecuteCommand,
  workflowCollectCommand,
  workflowPrepareCommand,
  workflowImportCommand,
} from './commands/workflow.js';
import { protocolPrintCommand } from './commands/protocol.js';
import { createCommandContext, type CommandContext } from './commands/runtime.js';
import {
  sessionCaptureCommand,
  sessionGateImportCommand,
  sessionGateRunCommand,
  sessionHeartbeatCommand,
  sessionListCommand,
  sessionNextCommand,
  sessionReconcileCommand,
  sessionReviewImportCommand,
  sessionStartCommand,
  sessionStatusCommand,
  sessionTransitionCommand,
} from './commands/session.js';
import { createInvalidArgumentError, toThreadloopError } from './contracts/errors.js';
import { renderCommandFailure } from './contracts/output.js';
import {
  ARTIFACT_KINDS,
  ENTRY_KINDS,
  ENTRY_SOURCES,
  HEARTBEAT_SOURCES,
  TASK_STATUS_VALUES,
  isTaskStatus,
} from './domain/types.js';

/**
 * Options that are required but validated by the command itself, so it can fail with SESSION_REQUIRED and a hint
 * instead of commander's generic missing-option error. Listed so the protocol still renders them as required.
 */
const HANDLER_REQUIRED_OPTIONS: Record<string, string[]> = {
  'session status': ['session'],
  'session capture': ['session'],
  'session heartbeat': ['session'],
};

/** Commands whose usage cannot be derived from their options. */
const USAGE_OVERRIDES: Record<string, string> = {
  'session reconcile': '(--session <id> | --all) [--json]',
  'audit corpus': '(--session <ids...> | --all) --output <path> [--format <format>] [--json]',
};

export function getProtocolCommandRules(commandPath: string) {
  return {
    handlerRequiredOptions: HANDLER_REQUIRED_OPTIONS[commandPath] ?? [],
    usageOverride: USAGE_OVERRIDES[commandPath],
  };
}

export function createThreadloopProgram() {
  const program = new Command();

  program
    .name('threadloop')
    .description('Task-first, repo-local session memory that generates review-ready artifacts')
    .version('0.1.0')
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: (text) => process.stdout.write(text),
      // Commander's own error text is replaced by ThreadLoop's failure envelope, but help shown because no
      // subcommand was given is the only guidance the caller gets, so it goes to stderr.
      writeErr: (text) => process.stderr.write(text),
      outputError: () => {},
    })
    .exitOverride();

  program.command('init').description('Initialize ThreadLoop in the current Git repo').action(action(initCommand));

  const artifact = program.command('artifact').description('Generate artifacts from session context');
  withJsonOption(
    artifact
      .command('generate')
      .description('Generate a Markdown artifact from task, notes, and Git context')
      .argument('[kind]', 'artifact kind', parseArtifactKind, 'change-brief')
      .option('--session <id>', 'session id to target'),
  ).action(action(artifactGenerateCommand));

  const session = program.command('session').description('Manage explicit ThreadLoop sessions');

  const executor = program.command('executor').description('Run the frozen GAAP reference process bridge');
  withJsonOption(
    executor
      .command('register')
      .description('Adopt a fresh host-controlled action and signer policy')
      .requiredOption('--state <directory>', 'new state directory outside the subject')
      .requiredOption('--binding <file>', 'host-adopted frozen controller binding JSON')
      .requiredOption('--config <file>', 'explicit process and verification configuration JSON'),
  ).action(
    action(async (context, options: { state: string; binding: string; config: string }) => {
      const { executorRegisterCommand } = await import('./commands/executor.js');
      await executorRegisterCommand(context, options);
    }),
  );
  withJsonOption(
    executor
      .command('run')
      .description('Launch the registered Attempt once and admit verified evidence')
      .requiredOption('--state <directory>', 'registered executor state directory'),
  ).action(
    action(async (context, options: { state: string }) => {
      const { executorRunCommand } = await import('./commands/executor.js');
      await executorRunCommand(context, options);
    }),
  );
  withJsonOption(
    executor
      .command('inspect')
      .description('Independently verify retained executor state without launching')
      .requiredOption('--state <directory>', 'executor state directory'),
  ).action(
    action(async (context, options: { state: string }) => {
      const { executorInspectCommand } = await import('./commands/executor.js');
      await executorInspectCommand(context, options);
    }),
  );
  withJsonOption(
    executor
      .command('admit')
      .description('Recheck retained output after an admission failure without launching')
      .argument('<observation-id>', 'retained successful transport observation')
      .requiredOption('--state <directory>', 'executor state directory'),
  ).action(
    action(async (context, observation: string, options: { state: string }) => {
      const { executorAdmitCommand } = await import('./commands/executor.js');
      await executorAdmitCommand(context, observation, options);
    }),
  );
  withJsonOption(
    executor
      .command('evaluate')
      .description('Re-evaluate lifecycle guards after evidence admission')
      .requiredOption('--state <directory>', 'executor state directory'),
  ).action(
    action(async (context, options: { state: string }) => {
      const { executorEvaluateCommand } = await import('./commands/executor.js');
      await executorEvaluateCommand(context, options);
    }),
  );

  withJsonOption(
    session
      .command('start')
      .description('Start a task-scoped session')
      .argument('<title>', 'task title')
      .option('--goal <goal>', 'goal for the task')
      .option('--constraint <constraint...>', 'constraints that matter for this task')
      .option('--base <ref>', 'base Git ref used for comparisons; defaults to main when available')
      .option('--issue <ref>', 'issue reference for branch and PR traceability')
      .option('--actor <actor>', 'entry actor for the initial intent record', parseEntrySource, 'cli')
      .option('--goal-edit', 'open $EDITOR for the goal text')
      .option(
        '--run-config <file>',
        'caller configuration and snapshot file paths for immutable audit attribution',
        parseInputPath,
      ),
  ).action(action(sessionStartCommand));

  withJsonOption(session.command('list').description('List sessions in the current workspace')).action(
    action(sessionListCommand),
  );

  withJsonOption(
    session
      .command('status')
      .description('Show status for an explicit session')
      .option('--session <id>', 'session id to target'),
  ).action(action(sessionStatusCommand));

  withJsonOption(
    session
      .command('capture')
      .description('Capture a structured checkpoint entry for an explicit session')
      .argument('<kind>', 'entry kind', parseEntryKind)
      .argument('[text]', 'entry text')
      .option('--session <id>', 'session id to target')
      .option('--because <reason>', 'optional reasoning or context')
      .option('--actor <actor>', 'entry actor for the captured note', parseEntrySource, 'cli')
      .option('--edit', 'open $EDITOR for longer text'),
  ).action(action(sessionCaptureCommand));

  withJsonOption(
    session
      .command('heartbeat')
      .description('Refresh mechanical session metadata without creating a semantic entry')
      .option('--session <id>', 'session id to target')
      .option('--source <source>', 'heartbeat source', parseHeartbeatSource),
  ).action(action(sessionHeartbeatCommand));

  withJsonOption(
    session
      .command('transition')
      .description('Apply an idempotent, guarded lifecycle transition')
      .argument('<target-state>', 'target lifecycle state', parseTaskStatus)
      .requiredOption('--session <id>', 'session id to target', parseRequiredText)
      .requiredOption(
        '--expected-state-version <version>',
        'optimistic lifecycle state version',
        parseExpectedStateVersion,
      )
      .requiredOption('--idempotency-key <key>', 'idempotency key for this canonical request', parseIdempotencyKey)
      .requiredOption('--actor <actor>', 'transition actor', parseEntrySource)
      .requiredOption(
        '--input <json-object>',
        'structured transition input, including proof_plan or pre_pr_review when required',
        parseJsonObject,
      ),
  ).action(action(sessionTransitionCommand));

  withJsonOption(
    session
      .command('next')
      .description('Inspect the deterministic next lifecycle candidate without mutating state')
      .requiredOption('--session <id>', 'session id to inspect', parseRequiredText),
  ).action(action(sessionNextCommand));

  const sessionGate = session.command('gate').description('Execute gates declared by the immutable proof plan');
  withJsonOption(
    sessionGate
      .command('run')
      .description('Run one declared local gate and append an immutable receipt')
      .argument('<gate-id>', 'declared proof-plan gate id', parseRequiredGateId)
      .requiredOption('--session <id>', 'session id to target', parseRequiredText),
  ).action(action(sessionGateRunCommand));
  withJsonOption(
    sessionGate
      .command('import')
      .description('Verify and append one signed GitHub Actions gate receipt')
      .argument('<package-path>', 'path to a signed receipt package')
      .requiredOption('--session <id>', 'session id to target', parseRequiredText),
  ).action(action(sessionGateImportCommand));

  const sessionReview = session.command('review').description('Import authoritative review evidence');
  withJsonOption(
    sessionReview
      .command('import')
      .description('Verify and append one signed GitHub review snapshot')
      .argument('<package-path>', 'path to a signed review package')
      .requiredOption('--session <id>', 'session id to target', parseRequiredText),
  ).action(action(sessionReviewImportCommand));

  withJsonOption(
    session
      .command('reconcile')
      .description('Refresh Git-derived metadata for a session without creating semantic entries')
      .option('--session <id>', 'session id to reconcile')
      .option('-a, --all', 'reconcile all active sessions'),
  ).action(action(sessionReconcileCommand));

  const audit = program.command('audit').description('Inspect and export the authoritative audit ledger');
  withJsonOption(
    audit
      .command('show')
      .description('Show hash-linked audit events for a session')
      .requiredOption('--session <id>', 'session id to inspect', parseRequiredText),
  ).action(action(auditShowCommand));
  withJsonOption(
    audit
      .command('verify')
      .description('Verify a session audit chain and optional retained root')
      .requiredOption('--session <id>', 'session id to verify', parseRequiredText)
      .option('--root <sha256>', 'previously retained audit root', parseSha256),
  ).action(action(auditVerifyCommand));
  withJsonOption(
    audit
      .command('export')
      .description('Verify and atomically create a JSONL audit export')
      .requiredOption('--session <id>', 'session id to export', parseRequiredText)
      .requiredOption('--output <path>', 'new output path; existing files are never overwritten', parseOutputPath),
  ).action(action(auditExportCommand));

  withJsonOption(
    audit
      .command('corpus')
      .description('Export a verified corpus with one outcome per session')
      .addOption(
        new Option('--format <format>', 'native corpus, viewer logs or verifiable logs')
          .choices(['native', 'otel', 'otel-verifiable'])
          .default('native'),
      )
      .option('--session <ids...>', 'explicit session ids to include')
      .option('--all', 'include every session in the current repository')
      .requiredOption('--output <path>', 'new output path; existing files are never overwritten', parseOutputPath),
  ).action(action(auditCorpusCommand));
  withJsonOption(
    audit
      .command('verify-export')
      .description('Verify retained corpus bytes without a repository or database')
      .requiredOption('--input <path>', 'retained corpus file', parseInputPath)
      .option('--root <sha256>', 'previously retained whole-file corpus root', parseSha256),
  ).action(action(auditVerifyExportCommand));

  const workflow = program.command('workflow').description('Manage graph-bound Workflow Runs');
  withJsonOption(
    workflow
      .command('create')
      .argument('<run-id>')
      .description('Create a run bound to one compiled graph and setup')
      .requiredOption('--profile <yaml>', 'workflow profile file')
      .requiredOption('--setup <json>', 'workflow setup file'),
  ).action(action(workflowCreateCommand));
  withJsonOption(
    workflow.command('inspect').argument('<run-id>').description('Read the verified graph binding and current state'),
  ).action(action(workflowInspectCommand));
  withJsonOption(
    workflow.command('decide').argument('<run-id>').description('Select the next outcome from verified run facts'),
  ).action(action(workflowDecideCommand));
  withJsonOption(
    workflow
      .command('apply')
      .argument('<run-id>')
      .description('Apply a fresh selected transition once')
      .requiredOption('--decision <file>', 'saved workflow decide JSON response')
      .requiredOption('--idempotency-key <key>', 'stable key for this request', parseIdempotencyKey),
  ).action(action(workflowApplyCommand));
  withJsonOption(
    workflow
      .command('execute')
      .argument('<run-id>')
      .description('Execute a selected engineering action through the enrolled GAAP bridge')
      .requiredOption('--decision <file>', 'saved workflow decide JSON response'),
  ).action(action(workflowExecuteCommand));
  const evidence = workflow.command('evidence').description('Prepare and admit authenticated workflow evidence');
  withJsonOption(
    evidence
      .command('collect')
      .argument('<kind>')
      .description('Collect local gate or pre-PR review evidence from the enrolled producer')
      .requiredOption('--run <run-id>', 'workflow run ID')
      .option('--gate <id>', 'adopted local proof gate', parseRequiredGateId)
      .option('--operation <id>', 'Qodo review operation UUID')
      .requiredOption('--expected-state-version <n>', 'expected lifecycle version', parseExpectedStateVersion)
      .requiredOption('--idempotency-key <key>', 'stable collection key', parseIdempotencyKey),
  ).action(action(workflowCollectCommand));
  withJsonOption(
    evidence
      .command('prepare')
      .argument('<kind>')
      .description('Bind a sensor observation to the current run')
      .requiredOption('--run <run-id>', 'workflow run ID')
      .option('--gate <id>', 'declared gate ID', parseRequiredGateId)
      .option('--pr <n>', 'positive pull request number', parsePositivePrNumber)
      .option('--instruction <file>', 'explicit human instruction file', parseInputPath)
      .requiredOption('--expected-state-version <n>', 'expected lifecycle version', parseExpectedStateVersion)
      .requiredOption('--idempotency-key <key>', 'stable preparation key', parseIdempotencyKey),
  ).action(action(workflowPrepareCommand));
  withJsonOption(
    evidence
      .command('import')
      .argument('<kind>')
      .description('Verify and retain a prepared sensor package')
      .requiredOption('--run <run-id>', 'workflow run ID')
      .requiredOption('--source <file>', 'signed sensor package or GAAP correlation file', parseInputPath)
      .requiredOption('--expected-state-version <n>', 'expected lifecycle version', parseExpectedStateVersion),
  ).action(action(workflowImportCommand));
  withJsonOption(
    program
      .command('protocol')
      .description('Print the agent integration protocol')
      .addOption(new Option('--contract <version>', 'protocol version to print').choices(['4', '5'])),
  ).action(
    action((context, options: { json?: boolean; contract?: '4' | '5' }) =>
      protocolPrintCommand(context, options, program),
    ),
  );

  return program;
}

/** Adapts a command handler to commander, which passes the parsed arguments followed by the options and command. */
function action<T extends unknown[]>(handler: (context: CommandContext, ...args: T) => void | Promise<void>) {
  return (...args: unknown[]) => {
    const command = args.at(-1) as Command;
    const context = createCommandContext(commandPath(command), command);
    return Promise.resolve(handler(context, ...(args.slice(0, -1) as T))).catch(handleCliError);
  };
}

export function commandPath(command: Command) {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(' ');
}

export function handleCliError(error: unknown) {
  if (
    error instanceof CommanderError &&
    (error.code === 'commander.version' || error.code === 'commander.helpDisplayed')
  ) {
    process.exitCode = 0;
    return;
  }
  // A missing subcommand already printed usage to stderr; it is still a failed invocation.
  if (error instanceof CommanderError && error.code === 'commander.help') {
    process.exitCode = error.exitCode;
    return;
  }

  const threadloopError =
    error instanceof CommanderError
      ? createInvalidArgumentError(error.message, { commander_code: error.code })
      : toThreadloopError(error);

  process.stderr.write(
    `${renderCommandFailure(
      invokedCommandPath(process.argv.slice(2)),
      {
        code: threadloopError.code,
        message: threadloopError.message,
        ...(threadloopError.details ? { details: threadloopError.details } : {}),
      },
      process.argv.includes('--json'),
    )}\n`,
  );
  process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
}

/**
 * Names the command a failed invocation targeted, including one commander rejected before any action ran. Known
 * command names are followed through the tree; an unknown name under a command group is reported as typed.
 */
function invokedCommandPath(argv: string[]) {
  const tokens = argv.filter((token) => token !== '--json');
  const names: string[] = [];
  let current = createThreadloopProgram();
  for (const token of tokens) {
    if (current.commands.length === 0 || token.startsWith('-')) {
      break;
    }
    names.push(token);
    const next = current.commands.find((command) => command.name() === token);
    if (!next) {
      break;
    }
    current = next;
  }
  return names.join(' ') || 'threadloop';
}

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

function parseEntrySource(value: string) {
  if (!ENTRY_SOURCES.includes(value as (typeof ENTRY_SOURCES)[number])) {
    throw new InvalidArgumentError(`Actor must be one of: ${ENTRY_SOURCES.join(', ')}`);
  }
  return value as (typeof ENTRY_SOURCES)[number];
}

function parseTaskStatus(value: string) {
  if (!isTaskStatus(value)) {
    throw new InvalidArgumentError(`Target state must be one of: ${TASK_STATUS_VALUES.join(', ')}`);
  }
  return value;
}

function parseSha256(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new InvalidArgumentError('Audit root must be 64 lowercase hexadecimal characters');
  }
  return value;
}

function parseRequiredText(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new InvalidArgumentError('Session id must be non-empty.');
  }
  return normalized;
}

function parseOutputPath(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new InvalidArgumentError('Output path must be non-empty.');
  }
  return normalized;
}

function parseInputPath(value: string) {
  const normalized = value.trim();
  if (!normalized) throw new InvalidArgumentError('Input path must be non-empty.');
  return normalized;
}

function parseRequiredGateId(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized) || normalized.length > 128) {
    throw new InvalidArgumentError('Gate id must match [A-Za-z0-9][A-Za-z0-9._-]* and be at most 128 characters.');
  }
  return normalized;
}

function parsePositivePrNumber(value: string) {
  const number = parseExpectedStateVersion(value);
  if (number === 0) throw new InvalidArgumentError('A pull request number must be positive.');
  return number;
}

function parseExpectedStateVersion(value: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new InvalidArgumentError('Expected state version must be a canonical non-negative integer.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError('Expected state version must not exceed Number.MAX_SAFE_INTEGER.');
  }
  return parsed;
}

function parseIdempotencyKey(value: string) {
  if (
    value.length < 1 ||
    value.length > 128 ||
    !/^[\x21-\x7e]+$/.test(value) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  ) {
    throw new InvalidArgumentError(
      'Idempotency key must be 1-128 ASCII characters and match [A-Za-z0-9][A-Za-z0-9._:/-]*.',
    );
  }
  return value;
}

function parseJsonObject(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError('Input must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidArgumentError('Input must be a non-null JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function withJsonOption<T extends Command>(command: T) {
  return command.addOption(new Option('--json', 'Output machine-readable JSON'));
}
