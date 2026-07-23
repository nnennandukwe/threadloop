import type { Argument, Command, Option } from 'commander';
import { ARTIFACT_KINDS, DEFAULT_BASE_REF, ENTRY_KINDS } from '../domain/types.js';
import { createNoopCliHandlers, createThreadloopProgram, getProtocolCommandRules } from '../cli-program.js';

export interface WorkflowContract {
  defaultBaseRef: string;
  branchNaming: {
    default: string;
    withIssue: string;
  };
  rebaseBeforePr: {
    required: boolean;
    upstream: string;
  };
  pr: {
    baseRef: string;
    bodyArtifact: string;
    titleSource: string;
    closingKeyword: string;
  };
  trackedFileMutations: 'none';
}

export interface ProtocolContract {
  envVars: Record<string, string>;
  commands: Record<string, string>;
  captureKinds: string[];
  artifactKinds: string[];
  workflow: WorkflowContract;
  notes: string[];
}

const EDITOR_ENV_DESCRIPTION = 'Editor command used by --edit and --goal-edit flows.';

export function buildProtocolContract(): ProtocolContract {
  const program = createThreadloopProgram(createNoopCliHandlers());
  const commands = Object.fromEntries(
    collectLeafCommands(program).map((command) => {
      const commandPath = getCommandPath(command);
      return [commandPath, formatCommandUsage(command, commandPath)];
    }),
  );

  return {
    envVars: deriveEnvVars(program),
    commands,
    captureKinds: [...ENTRY_KINDS],
    artifactKinds: [...ARTIFACT_KINDS],
    workflow: {
      defaultBaseRef: DEFAULT_BASE_REF,
      branchNaming: {
        default: 'threadloop/<slug>',
        withIssue: 'issue-<issue>/<slug>',
      },
      rebaseBeforePr: {
        required: true,
        upstream: `origin/${DEFAULT_BASE_REF}`,
      },
      pr: {
        baseRef: DEFAULT_BASE_REF,
        bodyArtifact: 'pr-summary',
        titleSource: 'task.title',
        closingKeyword: 'Closes',
      },
      trackedFileMutations: 'none',
    },
    notes: [
      'Only commands whose usage includes [--json] support machine-readable output.',
      'Session status, capture, heartbeat, transition, next, gate run, and gate import require --session <id>; session reconcile requires either --session <id> or --all.',
      'Session next is read-only; lifecycle completion is available only through an evidence-authorized session transition.',
      'Gate run executes only stored proof-plan argv, working directory, and timeout values; it never advances lifecycle state.',
      'Gate import verifies the immutable GitHub Actions and Sigstore policy from the v2 proof plan; no trust override is accepted.',
      'Review requires current-HEAD local proof and verified signed CI proof for every declared gate.',
      'Legacy root commands may auto-resolve a single active session when --session is omitted.',
      'ThreadLoop state and local receipt output are excluded through .git/info/exclude; review artifacts remain visible.',
      'Reconcile refreshes metadata without creating semantic entries.',
      'Session start auto-initializes ThreadLoop state when the repo has not been initialized yet.',
      'Orchestrators own fetch, branch creation, rebase, and PR opening; ThreadLoop records and renders the workflow state.',
    ],
  };
}

export function collectLeafCommands(program: Command) {
  return visitCommands(program).filter((command) => command.commands.length === 0);
}

export function getCommandPath(command: Command) {
  const names: string[] = [];
  let current: Command | null = command;

  while (current && current.parent) {
    names.unshift(current.name());
    current = current.parent;
  }

  return names.join(' ');
}

function visitCommands(command: Command): Command[] {
  return command.commands.flatMap((child) => [child, ...visitCommands(child)]);
}

function formatCommandUsage(command: Command, commandPath: string) {
  const rule = getProtocolCommandRules()[commandPath];
  const description = command.description();

  if (rule?.usageOverride) {
    return `threadloop ${commandPath} ${rule.usageOverride} - ${description}`;
  }

  const args = command.registeredArguments.map(formatArgumentToken);
  const options = command.options
    .filter((option) => option.long !== '--help')
    .map((option) => formatOptionToken(option, new Set(rule?.requiredOptions ?? [])));
  const tokens = ['threadloop', commandPath, ...args, ...options].filter(Boolean);

  return `${tokens.join(' ')} - ${description}`;
}

function formatArgumentToken(argument: Argument) {
  const name = argument.variadic ? `${argument.name()}...` : argument.name();
  return argument.required ? `<${name}>` : `[${name}]`;
}

function formatOptionToken(option: Option, requiredOptions: Set<string>) {
  const longForm = getLongOptionForm(option);
  if (requiredOptions.has(option.attributeName())) {
    return longForm;
  }
  return `[${longForm}]`;
}

function getLongOptionForm(option: Option) {
  return (
    option.flags
      .split(', ')
      .find((part) => part.startsWith('--'))
      ?.trim() ?? option.flags
  );
}

function deriveEnvVars(program: Command) {
  const usesEditor = collectLeafCommands(program).some((command) =>
    command.options.some((option) => option.attributeName() === 'edit' || option.attributeName() === 'goalEdit'),
  );

  if (!usesEditor) {
    return {};
  }

  return {
    EDITOR: EDITOR_ENV_DESCRIPTION,
  };
}
