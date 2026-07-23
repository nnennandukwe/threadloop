import { Command, InvalidArgumentError, Option } from 'commander';
import {
  ARTIFACT_KINDS,
  ENTRY_KINDS,
  ENTRY_SOURCES,
  HEARTBEAT_SOURCES,
  TASK_STATUS_VALUES,
  isTaskStatus,
} from './domain/types.js';

// Commander intentionally models command action arguments as a variadic any[] boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CliAction = (...args: any[]) => void | Promise<void>;

export interface ThreadloopCliHandlers {
  init: CliAction;
  start: CliAction;
  capture: CliAction;
  status: CliAction;
  artifactGenerate: CliAction;
  sessionStart: CliAction;
  sessionList: CliAction;
  sessionStatus: CliAction;
  sessionCapture: CliAction;
  sessionHeartbeat: CliAction;
  sessionTransition: CliAction;
  sessionNext: CliAction;
  sessionGateRun: CliAction;
  sessionGateImport: CliAction;
  sessionReconcile: CliAction;
  daemonRun: CliAction;
  protocol: CliAction;
}

export interface ProtocolCommandRule {
  requiredOptions?: string[];
  usageOverride?: string;
}

const PROTOCOL_COMMAND_RULES: Record<string, ProtocolCommandRule> = {
  'session status': { requiredOptions: ['session'] },
  'session capture': { requiredOptions: ['session'] },
  'session heartbeat': { requiredOptions: ['session'] },
  'session transition': {
    requiredOptions: ['session', 'expectedStateVersion', 'idempotencyKey', 'actor', 'input'],
  },
  'session next': { requiredOptions: ['session'] },
  'session gate run': { requiredOptions: ['session'] },
  'session gate import': { requiredOptions: ['session'] },
  'session reconcile': { usageOverride: '(--session <id> | --all) [--json]' },
};

const noopAction: CliAction = () => undefined;

export function createNoopCliHandlers(): ThreadloopCliHandlers {
  return {
    init: noopAction,
    start: noopAction,
    capture: noopAction,
    status: noopAction,
    artifactGenerate: noopAction,
    sessionStart: noopAction,
    sessionList: noopAction,
    sessionStatus: noopAction,
    sessionCapture: noopAction,
    sessionHeartbeat: noopAction,
    sessionTransition: noopAction,
    sessionNext: noopAction,
    sessionGateRun: noopAction,
    sessionGateImport: noopAction,
    sessionReconcile: noopAction,
    daemonRun: noopAction,
    protocol: noopAction,
  };
}

export function getProtocolCommandRules() {
  return PROTOCOL_COMMAND_RULES;
}

export function createThreadloopProgram(handlers: ThreadloopCliHandlers) {
  const program = new Command();

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

  program.command('init').description('Initialize ThreadLoop in the current Git repo').action(handlers.init);

  withJsonOption(
    program
      .command('start')
      .description('Start a task-scoped session')
      .argument('<title>', 'task title')
      .option('--goal <goal>', 'goal for the task')
      .option('--constraint <constraint...>', 'constraints that matter for this task')
      .option('--base <ref>', 'base Git ref used for comparisons; defaults to main when available')
      .option('--issue <ref>', 'issue reference for branch and PR traceability')
      .option('--actor <actor>', 'entry actor for the initial intent record', parseEntrySource, 'cli')
      .option('--goal-edit', 'open $EDITOR for the goal text'),
  ).action(handlers.start);

  withJsonOption(
    program
      .command('capture')
      .description('Capture a structured checkpoint entry')
      .argument('<kind>', 'entry kind', parseEntryKind)
      .argument('[text]', 'entry text')
      .option('--session <id>', 'session id to target')
      .option('--because <reason>', 'optional reasoning or context')
      .option('--actor <actor>', 'entry actor for the captured note', parseEntrySource, 'cli')
      .option('--edit', 'open $EDITOR for longer text'),
  ).action(handlers.capture);

  withJsonOption(
    program
      .command('status')
      .description('Show the current task/session status')
      .option('--session <id>', 'session id to target'),
  ).action(handlers.status);

  const artifact = program.command('artifact').description('Generate artifacts from session context');
  withJsonOption(
    artifact
      .command('generate')
      .description('Generate a Markdown artifact from task, notes, and Git context')
      .argument('[kind]', 'artifact kind', parseArtifactKind, 'change-brief')
      .option('--session <id>', 'session id to target'),
  ).action(handlers.artifactGenerate);

  const session = program.command('session').description('Manage explicit ThreadLoop sessions');

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
      .option('--goal-edit', 'open $EDITOR for the goal text'),
  ).action(handlers.sessionStart);

  withJsonOption(session.command('list').description('List sessions in the current workspace')).action(
    handlers.sessionList,
  );

  withJsonOption(
    session
      .command('status')
      .description('Show status for an explicit session')
      .option('--session <id>', 'session id to target'),
  ).action(handlers.sessionStatus);

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
  ).action(handlers.sessionCapture);

  withJsonOption(
    session
      .command('heartbeat')
      .description('Refresh mechanical session metadata without creating a semantic entry')
      .option('--session <id>', 'session id to target')
      .option('--source <source>', 'heartbeat source', parseHeartbeatSource),
  ).action(handlers.sessionHeartbeat);

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
      .requiredOption('--input <json-object>', 'structured transition input', parseJsonObject),
  ).action(handlers.sessionTransition);

  withJsonOption(
    session
      .command('next')
      .description('Inspect the deterministic next lifecycle candidate without mutating state')
      .requiredOption('--session <id>', 'session id to inspect', parseRequiredText),
  ).action(handlers.sessionNext);

  const sessionGate = session.command('gate').description('Execute gates declared by the immutable proof plan');
  withJsonOption(
    sessionGate
      .command('run')
      .description('Run one declared local gate and append an immutable receipt')
      .argument('<gate-id>', 'declared proof-plan gate id', parseRequiredGateId)
      .requiredOption('--session <id>', 'session id to target', parseRequiredText),
  ).action(handlers.sessionGateRun);
  withJsonOption(
    sessionGate
      .command('import')
      .description('Verify and append one signed GitHub Actions gate receipt')
      .argument('<package-path>', 'path to a signed receipt package')
      .requiredOption('--session <id>', 'session id to target', parseRequiredText),
  ).action(handlers.sessionGateImport);

  withJsonOption(
    session
      .command('reconcile')
      .description('Refresh Git-derived metadata for a session without creating semantic entries')
      .option('--session <id>', 'session id to reconcile')
      .option('-a, --all', 'reconcile all active sessions'),
  ).action(handlers.sessionReconcile);

  const daemon = program.command('daemon').description('Run ThreadLoop daemon for active session management');

  withJsonOption(
    daemon
      .command('run')
      .description('Run daemon to periodically reconcile active sessions')
      .option('-i, --interval <seconds>', 'reconciliation interval in seconds', parseIntervalSeconds, 60),
  ).action(handlers.daemonRun);

  withJsonOption(
    program.command('protocol').description('Print the agent integration protocol').action(handlers.protocol),
  );

  return program;
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

function parseRequiredText(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new InvalidArgumentError('Session id must be non-empty.');
  }
  return normalized;
}

function parseRequiredGateId(value: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized) || normalized.length > 128) {
    throw new InvalidArgumentError('Gate id must match [A-Za-z0-9][A-Za-z0-9._-]* and be at most 128 characters.');
  }
  return normalized;
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

function parseIntervalSeconds(value: string): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new InvalidArgumentError('Interval must be a positive number of seconds (minimum 1)');
  }
  return parsed;
}

function withJsonOption<T extends Command>(command: T) {
  return command.addOption(new Option('--json', 'Output machine-readable JSON'));
}
