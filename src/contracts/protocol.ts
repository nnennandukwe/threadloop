import type { Argument, Command, Option } from 'commander';
import { ARTIFACT_KINDS, DEFAULT_BASE_REF, ENTRY_KINDS } from '../domain/types.js';
import { commandPath, getProtocolCommandRules } from '../cli-program.js';

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
  contractVersions: {
    protocol: 4;
    proofPlan: 4;
    sessionNext: 4;
    signedReviewReceipt: 1;
    auditEvent: 1;
    handoff: 3;
  };
  envVars: Record<string, string>;
  commands: Record<string, string>;
  captureKinds: string[];
  artifactKinds: string[];
  workflow: WorkflowContract;
  notes: string[];
}

const EDITOR_ENV_DESCRIPTION = 'Editor command used by --edit and --goal-edit flows.';

/** Derives the command surface from the program itself, so the contract cannot drift from the CLI. */
export function buildProtocolContract(program: Command): ProtocolContract {
  const commands = Object.fromEntries(
    collectLeafCommands(program).map((command) => [commandPath(command), formatCommandUsage(command)]),
  );

  return {
    contractVersions: {
      protocol: 4,
      proofPlan: 4,
      sessionNext: 4,
      signedReviewReceipt: 1,
      auditEvent: 1,
      handoff: 3,
    },
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
      'Session status, capture, heartbeat, transition, next, gate run, gate import, and review import require --session <id>; session reconcile requires either --session <id> or --all.',
      'Session next is read-only; lifecycle completion is available only through an evidence-authorized session transition.',
      'Session next v4 separates repeatable pre-PR implementing work from bounded post-PR signed-review repair.',
      'Schema-v7 sessions report migration_required until threadloop init upgrades them; older schemas are rejected.',
      'Schema v8 widens the recorded gate result domain to admit setup_failed; threadloop init rebuilds gate_receipts in place and preserves every stored receipt.',
      'A gate whose declared setup fails records setup_failed, which is an operator handoff rather than code repair and consumes no repair budget.',
      'Gate run executes only stored proof-plan argv, working directory, and timeout values; it never advances lifecycle state.',
      'New proof plans require contract_version 4 with independent immutable CI and review trust policies; stored v1/v2/v3 plans remain readable for local gate execution.',
      'Proof-plan v4 gates may declare ordered setup steps that provision the toolchain before the gate command; each step is validated exactly as the gate command is.',
      'Gate import verifies the immutable GitHub Actions and Sigstore policy from the stored v2/v3/v4 proof plan; no trust override is accepted.',
      'Review receipt import verifies the current PR HEAD, canonical provider-neutral snapshot, in-toto subject, Sigstore signature, transparency log, workflow invocation identity, repository, session, and proof-plan bindings before persistence.',
      'Entering pre_pr_reviewing requires current-HEAD local proof and verified signed CI proof for every gate; post-PR human readiness additionally requires a current verified signed review receipt.',
      'Audit export verifies the hash-linked ledger and refuses to overwrite an existing output path.',
      'Artifact generate targets the only active session when --session is omitted.',
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

function visitCommands(command: Command): Command[] {
  return command.commands.flatMap((child) => [child, ...visitCommands(child)]);
}

function formatCommandUsage(command: Command) {
  const path = commandPath(command);
  const rule = getProtocolCommandRules(path);
  const description = command.description();

  if (rule.usageOverride) {
    return `threadloop ${path} ${rule.usageOverride} - ${description}`;
  }

  const handlerRequired = new Set(rule.handlerRequiredOptions);
  const args = command.registeredArguments.map(formatArgumentToken);
  const options = command.options
    .filter((option) => option.long !== '--help')
    .map((option) => formatOptionToken(option, option.mandatory || handlerRequired.has(option.attributeName())));
  const tokens = ['threadloop', path, ...args, ...options].filter(Boolean);

  return `${tokens.join(' ')} - ${description}`;
}

function formatArgumentToken(argument: Argument) {
  const name = argument.variadic ? `${argument.name()}...` : argument.name();
  return argument.required ? `<${name}>` : `[${name}]`;
}

function formatOptionToken(option: Option, required: boolean) {
  const longForm = getLongOptionForm(option);
  return required ? longForm : `[${longForm}]`;
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
