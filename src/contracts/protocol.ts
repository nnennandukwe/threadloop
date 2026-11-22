import type { Argument, Command, Option } from 'commander';
import { ARTIFACT_KINDS, DEFAULT_BASE_REF, ENTRY_KINDS } from '../domain/types.js';
import { commandPath, getProtocolCommandRules } from '../cli-program.js';
import { PROTOCOL_COMPONENT_VERSIONS } from './versions.js';

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

export interface WorkflowRunProtocol extends Omit<ProtocolContract, 'contractVersions'> {
  contractVersions: Omit<ProtocolContract['contractVersions'], 'protocol'> & { protocol: 5; workflowRun: 1 };
  capabilities: string[];
}

// Protocol v4 is still used by installed runners and historical run configurations.
const V4_COMMANDS = new Set([
  'init',
  'artifact generate',
  'session start',
  'session list',
  'session status',
  'session capture',
  'session heartbeat',
  'session transition',
  'session next',
  'session gate run',
  'session gate import',
  'session review import',
  'session reconcile',
  'executor register',
  'executor run',
  'executor inspect',
  'executor admit',
  'executor evaluate',
  'audit show',
  'audit verify',
  'audit export',
  'audit corpus',
  'audit verify-export',
  'protocol',
]);

const EDITOR_ENV_DESCRIPTION = 'Editor command used by --edit and --goal-edit flows.';

/** Derives the command surface from the program itself, so the contract cannot drift from the CLI. */
export function buildProtocolContract(program: Command, version?: 4): ProtocolContract;
export function buildProtocolContract(program: Command, version: 5): WorkflowRunProtocol;
export function buildProtocolContract(program: Command, version: 4 | 5): ProtocolContract | WorkflowRunProtocol;
export function buildProtocolContract(program: Command, version: 4 | 5 = 4): ProtocolContract | WorkflowRunProtocol {
  const leaves = collectLeafCommands(program).filter(
    (command) => version === 5 || V4_COMMANDS.has(commandPath(command)),
  );
  const commands = Object.fromEntries(
    leaves.map((command) => [commandPath(command), formatCommandUsage(command, version)]),
  );

  const legacy: ProtocolContract = {
    contractVersions: { ...PROTOCOL_COMPONENT_VERSIONS },
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
      'Session start records run-configuration v1 metadata; optional --run-config supplies caller declarations and snapshot paths without lifecycle authority.',
      'Audit corpus v1 uses one session as the comparison unit; verify-export checks retained bytes without a source repository or database. Metrics belong to external consumers.',
      'Audit corpus defaults to native. Use --format otel for a sanitized viewer or --format otel-verifiable to retain canonical records. Verify-export checks a native or verifiable file against its own optional whole-file root.',
      'Artifact generate targets the only active session when --session is omitted.',
      'ThreadLoop state and local receipt output are excluded through .git/info/exclude; review artifacts remain visible.',
      'Reconcile refreshes metadata without creating semantic entries.',
      'Session start auto-initializes ThreadLoop state when the repo has not been initialized yet.',
      'Orchestrators own fetch, branch creation, rebase, and PR opening; ThreadLoop records and renders the workflow state.',
    ],
  };
  if (version === 4) return legacy;
  return {
    ...legacy,
    contractVersions: { ...legacy.contractVersions, protocol: 5, workflowRun: 1 },
    capabilities: ['workflow_runs_v1', 'workflow_gaap_execution_v1', 'workflow_claim_expiry_v1'],
  };
}

export function collectLeafCommands(program: Command) {
  return visitCommands(program).filter((command) => command.commands.length === 0);
}

function visitCommands(command: Command): Command[] {
  return command.commands.flatMap((child) => [child, ...visitCommands(child)]);
}

function formatCommandUsage(command: Command, version: 4 | 5) {
  const path = commandPath(command);
  const rule = getProtocolCommandRules(path);
  const description = command.description();

  if (rule.usageOverride) {
    return `threadloop ${path} ${rule.usageOverride} - ${description}`;
  }

  const handlerRequired = new Set(rule.handlerRequiredOptions);
  const args = command.registeredArguments.map(formatArgumentToken);
  const options = command.options
    .filter(
      (option) => option.long !== '--help' && !(version === 4 && path === 'protocol' && option.long === '--contract'),
    )
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
