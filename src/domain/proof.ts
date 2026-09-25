import path from 'node:path';
import { z } from 'zod';
import { canonicalJson, isPlainObject } from './canonical-json.js';
import {
  boolean,
  commitSha,
  escapeRegExp,
  exactObject,
  githubRepository,
  identifier,
  integer,
  literal,
  parseFields,
  reject,
  rule,
  sha256Digest,
  text,
  canonicalTimestamp,
} from './validation.js';

export const GATE_RECEIPT_RESULTS = [
  'passed',
  'failed',
  'timed_out',
  'aborted',
  'invalidated',
  'execution_error',
  'cleanup_failed',
  'setup_failed',
] as const;

export type GateReceiptResult = (typeof GATE_RECEIPT_RESULTS)[number];

/** Bounds the declared provisioning sequence so a plan cannot describe unbounded pre-gate work. */
const MAXIMUM_SETUP_STEPS = 32;

export const gateReceiptResult = z.enum(GATE_RECEIPT_RESULTS, {
  error: `must be one of: ${GATE_RECEIPT_RESULTS.join(', ')}`,
});

/**
 * The execution shape shared by a gate command and every declared setup step, so a setup step can never be
 * validated more loosely than the gate command it provisions for.
 */
const execution = {
  command: rule(
    z.array(text(32_768), { error: 'must contain 1-128 exact argv strings' }),
    (command) => command.length >= 1 && command.length <= 128,
    'must contain 1-128 exact argv strings',
  ),
  working_directory: rule(
    rule(text(4_096), (directory) => !path.isAbsolute(directory), 'must be a repository-relative path'),
    (directory) => {
      const normalized = path.normalize(directory);
      return normalized !== '..' && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized);
    },
    'must not escape the repository',
  ),
  timeout_ms: integer(1, 86_400_000),
};

/**
 * A declared provisioning step. Shares the gate's own execution shape so validation and execution reuse one
 * code path, and so a receipt describes a setup step exactly as it describes the gate command.
 */
const setupStepSchema = exactObject({ id: identifier(128), ...execution });
export type ProofSetupStep = z.infer<typeof setupStepSchema>;

const setupStepsSchema = z
  .array(setupStepSchema, { error: 'must be an array of declared setup steps' })
  .refine((steps) => steps.length <= MAXIMUM_SETUP_STEPS, {
    message: `must declare no more than ${MAXIMUM_SETUP_STEPS} setup steps`,
    abort: true,
  })
  .superRefine((steps, context) => reportDuplicateIds(steps, context, 'duplicates declared setup step'));

export interface ProofGate {
  id: string;
  /**
   * Ordered provisioning steps run before `command`, declarable only by contract_version 4 plans. Absent
   * rather than empty when a gate needs no provisioning, so one canonical form means "no setup" and a
   * setup-free v4 gate canonicalizes identically to the same v3 gate.
   */
  setup?: ProofSetupStep[];
  command: string[];
  working_directory: string;
  timeout_ms: number;
}

/** Every gate a v1-v3 plan can declare. A gate carrying `setup` fails the exact-key check here. */
const setupFreeGateSchema: z.ZodType<ProofGate> = exactObject({ id: identifier(128), ...execution });

/**
 * A v4 gate, and the gate a signed artifact embeds. An empty `setup` array normalizes away, so only one canonical
 * form means "no provisioning".
 */
export const declaredGateSchema: z.ZodType<ProofGate> = exactObject(
  { id: identifier(128), setup: setupStepsSchema.exactOptional(), ...execution },
  { key: 'setup', expected: (gate) => 'setup' in gate },
).transform(({ id, setup, ...execution }) =>
  setup && setup.length > 0 ? { id, setup, ...execution } : { id, ...execution },
);

/**
 * One declared setup step as it actually ran. Recorded identically by the local and CI execution paths, so a
 * local receipt and a signed receipt for the same HEAD describe provisioning the same way.
 */
export const recordedSetupStepSchema = exactObject({
  id: identifier(128),
  ...execution,
  result: gateReceiptResult,
  started_at: canonicalTimestamp,
  ended_at: canonicalTimestamp,
  duration_ms: integer(0, 86_400_000),
  exit_status: integer(-2_147_483_648, 2_147_483_647).nullable(),
  signal: text(128).nullable(),
  head_before: commitSha,
  head_after: commitSha,
  clean_before: boolean,
  clean_after: boolean,
  output: exactObject({ stdout_sha256: sha256Digest, stderr_sha256: sha256Digest }),
});
export type RecordedSetupStep = z.infer<typeof recordedSetupStepSchema>;

const GITHUB_ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

function trustPolicySchema(sensorWorkflow: string) {
  return exactObject({
    provider: literal('github-actions'),
    issuer: literal(GITHUB_ACTIONS_ISSUER),
    certificate_identity: text(1_024),
    source_repository: githubRepository,
    build_signer_uri: text(1_024),
    build_signer_sha: commitSha,
  }).superRefine((policy, context) => {
    const workflowIdentity = new RegExp(
      `^${escapeRegExp(policy.source_repository)}/\\.github/workflows/[A-Za-z0-9._-]+\\.ya?ml@refs/heads/[A-Za-z0-9._/-]+$`,
    );
    if (!workflowIdentity.test(policy.certificate_identity)) {
      reject(context, ['certificate_identity'], 'must identify an exact workflow and branch in the source repository');
    }
    const expectedSignerUri = `https://github.com/nnennandukwe/threadloop/.github/workflows/${sensorWorkflow}@${policy.build_signer_sha}`;
    if (policy.build_signer_uri !== expectedSignerUri) {
      reject(context, ['build_signer_uri'], `must equal ${expectedSignerUri}`);
    }
  });
}

const ciPolicySchema = trustPolicySchema('threadloop-gate-sensor.yml');
const reviewPolicySchema = trustPolicySchema('threadloop-review-sensor.yml');
export type GitHubActionsTrustPolicy = z.infer<typeof ciPolicySchema>;

const acceptanceCriteriaSchema = rule(
  z.array(text(4_096), { error: 'must be a non-empty array of strings' }),
  (criteria) => criteria.length > 0,
  'must be a non-empty array of strings',
);

function gatesSchema(gate: z.ZodType<ProofGate>) {
  return rule(
    z.array(gate, { error: 'must be a non-empty array' }),
    (gates) => gates.length > 0,
    'must be a non-empty array',
  ).superRefine((gates, context) => reportDuplicateIds(gates, context, 'duplicates declared gate'));
}

/** Plans keyed by contract_version. Anything else is read as a legacy plan, whose key set has no version. */
const proofPlanSchemas = {
  legacy: exactObject({ acceptance_criteria: acceptanceCriteriaSchema, gates: gatesSchema(setupFreeGateSchema) }),
  2: exactObject({
    contract_version: z.literal(2),
    acceptance_criteria: acceptanceCriteriaSchema,
    ci: ciPolicySchema,
    gates: gatesSchema(setupFreeGateSchema),
  }),
  3: exactObject({
    contract_version: z.literal(3),
    acceptance_criteria: acceptanceCriteriaSchema,
    ci: ciPolicySchema,
    review: reviewPolicySchema,
    gates: gatesSchema(setupFreeGateSchema),
  }),
  4: exactObject({
    contract_version: z.literal(4),
    acceptance_criteria: acceptanceCriteriaSchema,
    ci: ciPolicySchema,
    review: reviewPolicySchema,
    gates: gatesSchema(declaredGateSchema),
  }),
};

export interface LegacyProofPlan {
  acceptance_criteria: string[];
  gates: ProofGate[];
}

export interface CiProofPlan extends LegacyProofPlan {
  contract_version: 2;
  ci: GitHubActionsTrustPolicy;
}

/** contract_version 4 differs from 3 only in admitting declared `setup` on its gates. */
export interface ReviewProofPlan extends LegacyProofPlan {
  contract_version: 3 | 4;
  ci: GitHubActionsTrustPolicy;
  review: GitHubActionsTrustPolicy;
}

export type ProofPlan = LegacyProofPlan | CiProofPlan | ReviewProofPlan;

export interface CanonicalProofPlan {
  plan: ProofPlan;
  json: string;
  sha256: string;
}

export interface BoundProofPlan extends CanonicalProofPlan {
  baselineBranch: string;
  baselineHeadSha: string;
  createdAt: string;
}

/**
 * Stored local receipts are only type-checked, as they always have been, rather than held to the signed-artifact
 * field rules: they are re-read on every evaluation, so a stricter field rule would retroactively corrupt them.
 */
const storedSetupStepSchema = z.object({
  id: z.string(),
  command: z.array(z.string()),
  working_directory: z.string(),
  timeout_ms: z.number(),
  result: z.enum(GATE_RECEIPT_RESULTS),
  started_at: z.string(),
  ended_at: z.string(),
  duration_ms: z.number(),
  exit_status: z.number().nullable(),
  signal: z.string().nullable(),
  head_before: z.string(),
  head_after: z.string(),
  clean_before: z.boolean(),
  clean_after: z.boolean(),
  output: z.object({ stdout_sha256: z.string(), stderr_sha256: z.string() }),
});

const gateReceiptPayloadSchema = z
  .object({
    id: z.string(),
    session_id: z.string(),
    gate_id: z.string(),
    plan_sha256: z.string(),
    result: z.enum(GATE_RECEIPT_RESULTS),
    /** Present on sensor contract_version 2 receipts; absent on stored v1 receipts, which predate setup. */
    setup: z.array(storedSetupStepSchema).optional(),
    command: z.array(z.string()),
    working_directory: z.string(),
    timeout_ms: z.number(),
    started_at: z.string(),
    ended_at: z.string(),
    duration_ms: z.number(),
    exit_status: z.number().nullable(),
    signal: z.string().nullable(),
    head_before: z.string(),
    head_after: z.string(),
    clean_before: z.boolean(),
    clean_after: z.boolean(),
    artifact: z.object({ path: z.string(), sha256: z.string() }),
    sensor: z.object({ name: z.literal('threadloop-local-gate'), contract_version: z.literal([1, 2]) }),
  })
  // v1 receipts predate setup and carry no `setup` key; v2 always carries one, possibly empty.
  .refine((payload) => (payload.sensor.contract_version === 2) === (payload.setup !== undefined));

export type GateReceiptPayload = z.infer<typeof gateReceiptPayloadSchema>;

export interface StoredGateReceipt {
  sequence: number;
  id: string;
  sessionId: string;
  gateId: string;
  planSha256: string;
  headBefore: string;
  headAfter: string;
  result: GateReceiptResult;
  artifactPath: string;
  artifactSha256: string;
  receiptJson: string;
  receiptSha256: string;
  stateVersion: number;
  createdAt: string;
}

/**
 * `setup_failed` is deliberately distinct from `failed`. A missing toolchain is a configuration problem, so
 * it must not select repair or consume post-PR repair budget the way a code failure does.
 */
export type ProofGateEvidenceStatus = 'missing' | 'passed' | 'failed' | 'setup_failed' | 'stale' | 'corrupt';
export type ProofEvidenceStatus = ProofGateEvidenceStatus;

export interface ProofGateEvidence {
  gate_id: string;
  status: ProofGateEvidenceStatus;
  receipt_id: string | null;
  sequence: number | null;
  result: GateReceiptResult | null;
}

export interface ProofEvidence {
  status: ProofEvidenceStatus;
  gates: ProofGateEvidence[];
  staleReceiptIds: string[];
  failedReceiptIds: string[];
  setupFailedReceiptIds: string[];
  corruptReceiptIds: string[];
}

export type ProofDigest = (value: string) => string;

export class ProofValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ProofValidationError';
    this.field = field;
  }
}

function proofValidationError(field: string, detail: string) {
  return new ProofValidationError(field, `${field} ${detail}.`);
}

export function canonicalizeProofPlan(
  value: unknown,
  digest: ProofDigest,
  options: { requireCiPolicy?: boolean; requireReviewPolicy?: boolean } = {},
): CanonicalProofPlan {
  const plan = validateProofPlan(value, options);
  const json = canonicalJson(plan);
  return { plan, json, sha256: digest(json) };
}

function validateProofPlan(
  value: unknown,
  options: { requireCiPolicy?: boolean; requireReviewPolicy?: boolean },
): ProofPlan {
  if (!isPlainObject(value)) {
    throw proofValidationError('proof_plan', 'must be an object');
  }
  const version = value.contract_version;
  const signed = version === 2 || version === 3 || version === 4;
  if (!signed && options.requireCiPolicy) {
    throw proofValidationError('proof_plan.contract_version', 'must be 2, 3, or 4 for newly recorded proof plans');
  }
  if (version !== 4 && options.requireReviewPolicy) {
    throw proofValidationError('proof_plan.contract_version', 'must be 4 for newly recorded proof plans');
  }
  const schema = version === 2 || version === 3 || version === 4 ? proofPlanSchemas[version] : proofPlanSchemas.legacy;
  return parseFields(schema, value, 'proof_plan', proofValidationError);
}

/**
 * Validates one declared gate. Exported because the CI sensor receives a single gate rather than a whole plan
 * and must apply exactly these rules: wrapping the gate in a synthetic legacy plan would silently reject
 * declared `setup`, since only contract_version 4 admits it.
 *
 * `allowSetup` is the version gate. When false, a gate carrying `setup` fails the exact-field check rather
 * than having the field ignored.
 */
export function validateDeclaredGate(
  value: unknown,
  options: { field?: string; allowSetup?: boolean } = {},
): ProofGate {
  const schema = (options.allowSetup ?? true) ? declaredGateSchema : setupFreeGateSchema;
  return parseFields(schema, value, options.field ?? 'gate', proofValidationError);
}

export function hasCiTrustPolicy(plan: ProofPlan): plan is CiProofPlan | ReviewProofPlan {
  return (
    'contract_version' in plan &&
    (plan.contract_version === 2 || plan.contract_version === 3 || plan.contract_version === 4)
  );
}

export function hasReviewTrustPolicy(plan: ProofPlan): plan is ReviewProofPlan {
  return 'contract_version' in plan && (plan.contract_version === 3 || plan.contract_version === 4);
}

export function evaluateProofEvidence(input: {
  sessionId: string;
  plan: BoundProofPlan;
  receipts: StoredGateReceipt[];
  currentHead: string | null;
  artifactDigests: ReadonlyMap<string, string | null>;
  digest: ProofDigest;
}): ProofEvidence {
  const latestByGate = latestBy(input.receipts, (receipt) => receipt.gateId);
  const gates = input.plan.plan.gates.map((gate): ProofGateEvidence => {
    const receipt = latestByGate.get(gate.id);
    if (!receipt) {
      return { gate_id: gate.id, status: 'missing', receipt_id: null, sequence: null, result: null };
    }
    const common = {
      gate_id: gate.id,
      receipt_id: receipt.id,
      sequence: receipt.sequence,
      result: receipt.result,
    };
    const payload = parseAndValidateReceipt(
      receipt,
      input.sessionId,
      gate,
      input.artifactDigests.get(receipt.id),
      input.digest,
    );
    if (!payload) {
      return { ...common, status: 'corrupt' };
    }
    if (
      receipt.planSha256 !== input.plan.sha256 ||
      payload.plan_sha256 !== input.plan.sha256 ||
      !input.currentHead ||
      receipt.headBefore !== input.currentHead ||
      receipt.headAfter !== input.currentHead
    ) {
      return { ...common, status: 'stale' };
    }
    if (receipt.result === 'passed' && payload.result === 'passed' && payload.clean_before && payload.clean_after) {
      return { ...common, status: 'passed' };
    }
    if (receipt.result === 'setup_failed' && payload.result === 'setup_failed') {
      return { ...common, status: 'setup_failed' };
    }
    return { ...common, status: 'failed' };
  });

  const receiptIds = (status: ProofGateEvidenceStatus) =>
    gates.flatMap((gate) => (gate.status === status && gate.receipt_id ? [gate.receipt_id] : []));
  return {
    status: aggregateGateStatus(gates.map((gate) => gate.status)),
    gates,
    staleReceiptIds: receiptIds('stale'),
    failedReceiptIds: receiptIds('failed'),
    setupFailedReceiptIds: receiptIds('setup_failed'),
    corruptReceiptIds: receiptIds('corrupt'),
  };
}

/** The receipt with the highest sequence for each key. */
export function latestBy<R extends { sequence: number }>(receipts: readonly R[], key: (receipt: R) => string) {
  const latest = new Map<string, R>();
  for (const receipt of [...receipts].sort((left, right) => left.sequence - right.sequence)) {
    latest.set(key(receipt), receipt);
  }
  return latest;
}

/**
 * One aggregate for local and signed CI evidence. `setup_failed` outranks `failed` because a broken environment
 * is the actionable root cause: a gate that never ran its command tells you nothing about the code.
 */
export function aggregateGateStatus<S extends ProofGateEvidenceStatus>(statuses: readonly S[]): S {
  if (statuses.every((status) => status === 'passed')) {
    return 'passed' as S;
  }
  const precedence = ['corrupt', 'setup_failed', 'failed', 'stale', 'missing'] as const;
  return (precedence.find((status) => (statuses as readonly string[]).includes(status)) ?? 'missing') as S;
}

function parseAndValidateReceipt(
  receipt: StoredGateReceipt,
  sessionId: string,
  gate: ProofGate,
  artifactDigest: string | null | undefined,
  digest: ProofDigest,
) {
  if (
    !Number.isSafeInteger(receipt.sequence) ||
    receipt.sequence < 1 ||
    receipt.receiptSha256 !== digest(receipt.receiptJson)
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(receipt.receiptJson) as unknown;
  } catch {
    return null;
  }
  if (canonicalJson(parsed) !== receipt.receiptJson || !gateReceiptPayloadSchema.safeParse(parsed).success) {
    return null;
  }
  const payload = parsed as GateReceiptPayload;
  if (
    payload.id !== receipt.id ||
    payload.session_id !== sessionId ||
    payload.gate_id !== receipt.gateId ||
    payload.plan_sha256 !== receipt.planSha256 ||
    payload.result !== receipt.result ||
    payload.head_before !== receipt.headBefore ||
    payload.head_after !== receipt.headAfter ||
    payload.artifact.path !== receipt.artifactPath ||
    payload.artifact.sha256 !== receipt.artifactSha256 ||
    artifactDigest !== receipt.artifactSha256 ||
    payload.working_directory !== gate.working_directory ||
    payload.timeout_ms !== gate.timeout_ms ||
    JSON.stringify(payload.command) !== JSON.stringify(gate.command) ||
    recordedSetupViolation(payload.setup, gate.setup, payload.result)
  ) {
    return null;
  }
  return payload;
}

/**
 * Why recorded setup does not correspond to the gate's declaration, or null when it does. One rule for local
 * receipts and signed artifacts, so the two cannot disagree about the same execution. The path is relative to
 * the recorded setup array.
 *
 * Setup is recorded positionally and stops at the first step that does not pass, so a non-passing step is
 * always the last one recorded. Only a result reachable before the gate command ran may record a short
 * sequence: `setup_failed`, `invalidated` (a setup step changed the repository), and `aborted`, because the CI
 * signer reports a cancelled job as `aborted` whenever GitHub cancelled it, including mid-setup. Every other
 * result means the gate command ran, which requires every declared step to have passed.
 */
export function recordedSetupViolation(
  recordedSteps:
    readonly Pick<RecordedSetupStep, 'id' | 'command' | 'working_directory' | 'timeout_ms' | 'result'>[] | undefined,
  declaredSteps: readonly ProofSetupStep[] | undefined,
  result: GateReceiptResult,
): { path: Array<string | number>; message: string } | null {
  const recorded = recordedSteps ?? [];
  const declared = declaredSteps ?? [];
  const commandRan = result !== 'setup_failed' && result !== 'invalidated' && result !== 'aborted';
  const violation = (message: string, ...path: Array<string | number>) => ({ path, message });
  if (result === 'setup_failed' && declared.length === 0) {
    return violation('cannot be setup_failed when the gate declares no setup');
  }
  if (recorded.length > declared.length) {
    return violation('must not record more steps than the gate declares');
  }
  if (result === 'setup_failed' && recorded.length === 0) {
    return violation('must record the setup step that failed');
  }
  if (commandRan && recorded.length !== declared.length) {
    return violation('must record every declared setup step for this receipt result');
  }
  const mismatch = recorded.findIndex((step, index) => {
    const expected = declared[index];
    return (
      !expected ||
      step.id !== expected.id ||
      step.working_directory !== expected.working_directory ||
      step.timeout_ms !== expected.timeout_ms ||
      canonicalJson(step.command) !== canonicalJson(expected.command)
    );
  });
  if (mismatch !== -1) {
    return violation('must match the setup step the gate declares at the same position', mismatch);
  }
  const firstNonPassing = recorded.findIndex((step) => step.result !== 'passed');
  if (firstNonPassing === -1) {
    return result === 'setup_failed' ? violation('must include a non-passing setup step') : null;
  }
  if (commandRan) {
    return violation('must be passed when the gate command ran', firstNonPassing, 'result');
  }
  if (firstNonPassing !== recorded.length - 1) {
    return violation('the first non-passing setup step must be the last recorded step', firstNonPassing, 'result');
  }
  return null;
}

function reportDuplicateIds(entries: readonly { id: string }[], context: z.RefinementCtx, message: string) {
  const seen = new Set<string>();
  for (const [index, { id }] of entries.entries()) {
    if (seen.has(id)) {
      reject(context, [index, 'id'], `${message} ${id}`);
      return;
    }
    seen.add(id);
  }
}
