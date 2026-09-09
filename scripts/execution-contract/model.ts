import { withinExecutionLimits } from './limits.js';
import { isExecutionAdmitted, type ExecutionAuthority } from './authority.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { createIncrementalSha256, sha256 } from '../../src/adapters/crypto/sha256.js';
import { actionRequestSchema, type ActionRequest, type ControllerInput } from '../controller-contract/contracts.js';
import { same, validateControllerInput, validateRequestInSnapshot } from '../controller-contract/validation.js';
import { diagnostic, validateShape, type ValidationResult } from '../workflow-graph/contracts.js';
import {
  executionContextSchema,
  executionJournalSchema,
  executionOperationSchema,
  executionPolicySchema,
  type Attempt,
  type AttemptReceipt,
  type ExecutionClaim,
  type ExecutionContext,
  type ExecutionJournal,
  type ExecutionOperation,
  type RecoveryEvidence,
  type ReceiptAdmission,
} from './contracts.js';

export interface OperationResult {
  disposition: 'applied' | 'rejected' | 'conflict';
  code: string;
  revision: number;
  claim: { id: string; version: number } | null;
  attempt_id: string | null;
  recovery: string;
}

export interface ExecutionProjection {
  revision: number;
  evaluated_at: string;
  request_status: 'open' | 'satisfied' | 'cancelled' | 'invalidated';
  claims: ExecutionClaim[];
  attempts: Attempt[];
  receipts: { envelope: AttemptReceipt; result: OperationResult }[];
  conflicts: {
    id: string;
    namespace: 'operation' | 'request' | 'receipt' | 'claim' | 'attempt' | 'recovery_evidence' | 'receipt_admission';
    identity: string;
    original_digest: string;
    incoming_digest: string;
    resolved_by: string | null;
    result: OperationResult;
  }[];
  invalidated_claims: { id: string; version: number }[];
  operations: { id: string; digest: string; result: OperationResult }[];
}

type IdentityCollision = Pick<
  ExecutionProjection['conflicts'][number],
  'namespace' | 'identity' | 'original_digest' | 'incoming_digest'
>;
interface ObservationRecord {
  namespace: 'recovery_evidence' | 'receipt_admission';
  identity: string;
  content: RecoveryEvidence | ReceiptAdmission;
}

interface ReplayIndex {
  observations: Map<string, ObservationRecord>;
  operations: Map<string, ExecutionProjection['operations'][number]>;
  grantsByClaim: Map<string, { operation: ExecutionOperation; result: OperationResult }>;
  grantsByAttempt: Map<string, ExecutionOperation>;
}

function newReplayIndex(context: ExecutionContext): ReplayIndex {
  const index: ReplayIndex = {
    observations: new Map(),
    operations: new Map(),
    grantsByClaim: new Map(),
    grantsByAttempt: new Map(),
  };
  rememberObservations(index, context);
  return index;
}

function observationKey(record: ObservationRecord): string {
  return canonicalJson([record.namespace, record.identity]);
}

function rememberObservations(index: ReplayIndex, context: ExecutionContext): void {
  for (const record of contextObservations(context)) {
    const key = observationKey(record);
    if (!index.observations.has(key)) index.observations.set(key, record);
  }
}

function rememberOperation(
  index: ReplayIndex,
  state: ExecutionProjection,
  operation: ExecutionOperation,
  digest: string,
  result: OperationResult,
): void {
  const record = { id: operation.id, digest, result };
  state.operations.push(record);
  index.operations.set(operation.id, record);
  const command = operation.command;
  if (command.kind === 'acquire' || command.kind === 'replace') {
    if (!index.grantsByClaim.has(command.claim_id)) index.grantsByClaim.set(command.claim_id, { operation, result });
    if (!index.grantsByAttempt.has(command.attempt_id)) index.grantsByAttempt.set(command.attempt_id, operation);
  }
}

function contextObservations(context: ExecutionContext): ObservationRecord[] {
  return [
    ...context.recovery_evidence.map((record) => ({
      namespace: 'recovery_evidence' as const,
      identity: record.evidence.id,
      content: record,
    })),
    ...context.receipt_admissions.map((record) => ({
      namespace: 'receipt_admission' as const,
      identity: record.admission.id,
      content: record,
    })),
  ];
}

function observationConflicts(
  previous: Map<string, ObservationRecord>,
  incoming: ObservationRecord[],
): IdentityCollision[] {
  const added = new Map<string, ObservationRecord>();
  const collisions: IdentityCollision[] = [];
  for (const record of incoming) {
    const key = observationKey(record);
    const original = previous.get(key) ?? added.get(key);
    if (original && !same(original.content, record.content))
      collisions.push({
        namespace: record.namespace,
        identity: record.identity,
        original_digest: executionDigest(original.content),
        incoming_digest: executionDigest(record.content),
      });
    if (!original) added.set(key, record);
  }
  return collisions;
}

export function executionDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function invalid<T>(code: string, message: string): ValidationResult<T> {
  return {
    ok: false,
    diagnostics: [
      diagnostic(code, '$', null, message, 'Restore the exact contract input; no journal append is proposed.'),
    ],
  };
}

export function requestReference(request: ActionRequest) {
  return { idempotency_key: request.request.idempotency_key, request_digest: request.request_digest };
}

function contextTime(context: ExecutionContext): ValidationResult<string> {
  const parsed = validateControllerInput(context.snapshot);
  if (!parsed.ok) return parsed;
  const time = context.snapshot.evaluation_time;
  if (time === null) return invalid('EVALUATION_TIME_REQUIRED', 'Execution requires explicit UTC time.');
  return { ok: true, value: time };
}

function controlActor(context: ExecutionContext, kind: 'human' | 'threadloop'): boolean {
  const actor = context.actor;
  return (
    actor.kind === kind &&
    context.snapshot.policy.rules.authorities.some(
      (authority) => authority.type === kind && same(authority.identity, actor.identity),
    )
  );
}

export function createExecutionJournal(
  context: unknown,
  request: unknown,
  policy: unknown,
  authority: ExecutionAuthority,
): ValidationResult<ExecutionJournal> {
  if (![context, request, policy].every(withinExecutionLimits))
    return invalid(
      'EXECUTION_INPUT_LIMIT',
      'Input exceeds the bounded development validator limits. Retain the complete input for an implementation with sufficient capacity.',
    );
  const parsedContext = validateShape(executionContextSchema, context);
  if (!parsedContext.ok) return parsedContext;
  const parsedRequest = validateShape(actionRequestSchema, request);
  if (!parsedRequest.ok) return parsedRequest;
  const parsedPolicy = validateShape(executionPolicySchema, policy);
  if (!parsedPolicy.ok) return parsedPolicy;
  if (
    !isExecutionAdmitted(authority, {
      kind: 'create',
      context: parsedContext.value,
      request: parsedRequest.value,
      policy: parsedPolicy.value,
    })
  )
    return invalid(
      'UNTRUSTED_EXECUTION_INPUT',
      'Independent authority must admit the exact initial request, policy, and context.',
    );
  const current = parsedContext.value;
  const time = contextTime(current);
  if (!time.ok) return time;
  const bound = validateRequestInSnapshot(current.snapshot, parsedRequest.value);
  if (!bound.ok) return bound;
  if (bound.value.request.actor !== 'executor')
    return invalid('HUMAN_REQUEST', 'Human requests cannot acquire claims.');
  if (!controlActor(current, 'threadloop')) return invalid('AUTHORITY_MISMATCH', 'ThreadLoop admits execution policy.');
  if (observationConflicts(new Map(), contextObservations(current)).length > 0)
    return invalid('INITIAL_EVIDENCE_CONFLICT', 'Initial observation identities must have one immutable value.');
  const executionPolicy = parsedPolicy.value;
  if (
    executionPolicy.digest !== executionDigest(executionPolicy.rules) ||
    !same(executionPolicy.rules.request, requestReference(bound.value)) ||
    !same(executionPolicy.rules.workflow_policy, bound.value.request.policy)
  )
    return invalid('EXECUTION_POLICY_MISMATCH', 'Execution policy must bind the exact request and Workflow policy.');
  const execution: ExecutionJournal['execution'] = {
    schema_version: '0.1',
    action_request: bound.value,
    execution_policy: executionPolicy,
    initial_context: current,
    entries: [],
  };
  return sealJournal(execution);
}

function emptyProjection(time: string): ExecutionProjection {
  return {
    revision: 0,
    evaluated_at: time,
    request_status: 'open',
    claims: [],
    attempts: [],
    receipts: [],
    conflicts: [],
    invalidated_claims: [],
    operations: [],
  };
}

export function projectControllerExecution(
  journal: unknown,
  snapshot: unknown,
  authority: ExecutionAuthority,
): ValidationResult<Pick<ControllerInput, 'execution' | 'invalidated_claims' | 'existing_requests'>> {
  if (![journal, snapshot].every(withinExecutionLimits))
    return invalid(
      'EXECUTION_INPUT_LIMIT',
      'Input exceeds the bounded development validator limits; no projection is produced.',
    );
  const parsed = validateShape(executionJournalSchema, journal);
  if (!parsed.ok) return parsed;
  const replayed = replayExecutionJournal(parsed.value, authority);
  if (!replayed.ok) return replayed;
  const current = validateControllerInput(snapshot);
  if (!current.ok) return current;
  if (
    !isExecutionAdmitted(authority, {
      kind: 'projection',
      execution_digest: parsed.value.execution_digest,
      snapshot: current.value,
    })
  )
    return invalid('UNTRUSTED_EXECUTION_INPUT', 'Independent authority must admit the current projection snapshot.');
  const input = current.value;
  const state = replayed.value;
  const request = parsed.value.execution.action_request;
  const now = input.evaluation_time;
  if (now === null || now < state.evaluated_at)
    return invalid('INVALID_PROJECTION_TIME', 'Projection requires current explicit authority time.');
  if (
    input.binding.workflow_run_id !== request.request.binding.workflow_run_id ||
    input.binding.graph_digest !== request.request.binding.graph_digest
  )
    return invalid('CONTEXT_BINDING_MISMATCH', 'Projection must retain the Workflow Run and graph.');
  if (request.request.actor !== 'executor')
    return invalid('HUMAN_REQUEST', 'Execution projections require executor requests.');
  if (input.execution.status !== 'idle' && !same(input.execution.request, request))
    return invalid(
      'OTHER_EXECUTION_OUTSTANDING',
      'Cannot replace another execution obligation in the controller snapshot.',
    );
  const invalidated = [...input.invalidated_claims];
  for (const claim of state.invalidated_claims)
    if (!invalidated.some((item) => same(item, claim))) invalidated.push(claim);
  const existing = [...input.existing_requests];
  const registered = existing.find((item) => item.idempotency_key === request.request.idempotency_key);
  if (registered && registered.request_digest !== request.request_digest)
    return invalid('IDEMPOTENCY_CONFLICT', 'Controller registry disagrees with the admitted request.');
  if (!registered) existing.push(requestReference(request));
  const claim = state.claims.at(-1);
  const attempt = state.attempts.at(-1);
  const unresolved = state.attempts.find(
    (item) =>
      item.resolution === null &&
      (item.effect === 'unknown' || (item.effect === 'occurred' && item.status !== 'succeeded')),
  );
  const envelope = { request: request.request, request_digest: request.request_digest };
  let execution: ControllerInput['execution'] = { status: 'idle' };
  const blocked = (
    reason: Extract<ControllerInput['execution'], { status: 'reconciliation_required' }>['reason'],
    unresolvedAttempt = attempt,
  ): ControllerInput['execution'] => ({
    status: 'reconciliation_required',
    request: envelope,
    claim: unresolvedAttempt?.claim ?? (claim ? reference(claim) : null),
    attempt_id: unresolvedAttempt?.id ?? null,
    reason,
  });
  if (state.conflicts.some((record) => record.resolved_by === null) || state.request_status === 'invalidated')
    execution = blocked('conflict', unresolved ?? attempt);
  else if (claim?.status === 'active' && attempt) {
    if (fenced(claim, input, now)) execution = blocked(deadlinePassed(claim.valid_until, now) ? 'expired' : 'conflict');
    else if (!validateRequestInSnapshot(input, request, 'in_flight').ok) execution = blocked('conflict');
    else if (attempt.status === 'pending' || attempt.status === 'running')
      execution = {
        status: 'in_flight',
        request: envelope,
        claim: { ...reference(claim), valid_until: claim.valid_until },
        attempt: { id: attempt.id, status: attempt.status },
      };
  } else {
    if (!validateRequestInSnapshot(input, request, 'in_flight').ok)
      execution = blocked('conflict', unresolved ?? attempt);
    else if (unresolved)
      execution = blocked(state.request_status === 'cancelled' ? 'cancelled' : 'unknown_outcome', unresolved);
  }
  return { ok: true, value: { execution, invalidated_claims: invalidated, existing_requests: existing } };
}

/** Reconstructs statuses from retained operations; an asserted mutable projection is never trusted. */
export function replayExecutionJournal(
  journal: unknown,
  authority: ExecutionAuthority,
): ValidationResult<ExecutionProjection> {
  const replayed = replay(journal, authority);
  return replayed.ok ? { ok: true, value: replayed.value.projection } : replayed;
}

function replay(
  journal: unknown,
  authority: ExecutionAuthority,
): ValidationResult<{ projection: ExecutionProjection; index: ReplayIndex }> {
  if (!withinExecutionLimits(journal))
    return invalid(
      'EXECUTION_INPUT_LIMIT',
      'Journal exceeds the bounded development validator limits; retain its complete history.',
    );
  const parsed = validateShape(executionJournalSchema, journal);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value.execution_digest !== executionDigest(value.execution))
    return invalid('EXECUTION_DIGEST_MISMATCH', 'The journal differs from its canonical digest.');
  const initial = createExecutionJournal(
    value.execution.initial_context,
    value.execution.action_request,
    value.execution.execution_policy,
    authority,
  );
  if (!initial.ok) return initial;
  const prefix = initial.value;
  const hasher = journalPrefixHasher(value.execution);
  const index = newReplayIndex(value.execution.initial_context);
  const projection = emptyProjection(value.execution.initial_context.snapshot.evaluation_time!);
  for (const entry of value.execution.entries) {
    const applied = step(prefix, projection, entry.context, entry.operation, authority, index);
    if (!applied.ok) return applied;
    if (applied.value.replayed) return invalid('DUPLICATE_JOURNAL_ENTRY', 'Exact deliveries must not append twice.');
    prefix.execution.entries.push(entry);
    prefix.execution_digest = hasher.append(entry);
  }
  return { ok: true, value: { projection, index } };
}

/** Hash the invariant fields once and extend only the entries array during replay. */
function journalPrefixHasher(execution: ExecutionJournal['execution']) {
  const fields = Object.entries(execution)
    .filter(([key]) => key !== 'entries')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, json: `${JSON.stringify(key)}:${canonicalJson(value)}` }));
  const before = fields.filter((field) => field.key < 'entries').map((field) => field.json);
  const after = fields.filter((field) => field.key > 'entries').map((field) => field.json);
  const hash = createIncrementalSha256();
  hash.update(`{${before.length ? before.join(',') + ',' : ''}"entries":[`);
  const suffix = `]${after.length ? ',' + after.join(',') : ''}}`;
  let count = 0;
  return {
    append(entry: ExecutionJournal['execution']['entries'][number]): string {
      if (count++ > 0) hash.update(',');
      hash.update(canonicalJson(entry));
      return hash.digest(suffix);
    },
  };
}

function sealJournal(execution: ExecutionJournal['execution']): ValidationResult<ExecutionJournal> {
  const envelope = { execution, execution_digest: '0'.repeat(64) };
  if (!withinExecutionLimits(envelope))
    return invalid(
      'EXECUTION_INPUT_LIMIT',
      'Journal capacity reached; preserve the complete history and use an implementation with sufficient capacity. Never truncate or reset the request.',
    );
  return { ok: true, value: { execution, execution_digest: executionDigest(execution) } };
}

export function applyExecutionOperation(
  journal: unknown,
  context: unknown,
  operation: unknown,
  authority: ExecutionAuthority,
): ValidationResult<{
  expected_execution_digest: string;
  journal: ExecutionJournal;
  projection: ExecutionProjection;
  result: OperationResult;
  replayed: boolean;
}> {
  if (![journal, context, operation].every(withinExecutionLimits))
    return invalid(
      'EXECUTION_INPUT_LIMIT',
      'Input exceeds the bounded development validator limits; no append is proposed.',
    );
  const history = validateShape(executionJournalSchema, journal);
  if (!history.ok) return history;
  const state = replay(history.value, authority);
  if (!state.ok) return state;
  const parsedContext = validateShape(executionContextSchema, context);
  if (!parsedContext.ok) return parsedContext;
  const parsedOperation = validateShape(executionOperationSchema, operation);
  if (!parsedOperation.ok) return parsedOperation;
  const applied = step(
    history.value,
    state.value.projection,
    parsedContext.value,
    parsedOperation.value,
    authority,
    state.value.index,
  );
  if (!applied.ok) return applied;
  const proposed = applied.value.replayed
    ? { ok: true as const, value: history.value }
    : sealJournal({
        ...history.value.execution,
        entries: [
          ...history.value.execution.entries,
          { context: parsedContext.value, operation: parsedOperation.value },
        ],
      });
  if (!proposed.ok) return proposed;
  return {
    ok: true,
    value: {
      expected_execution_digest: history.value.execution_digest,
      journal: proposed.value,
      projection: state.value.projection,
      ...applied.value,
    },
  };
}

function step(
  journal: ExecutionJournal,
  state: ExecutionProjection,
  context: ExecutionContext,
  operation: ExecutionOperation,
  authority: ExecutionAuthority,
  index: ReplayIndex,
): ValidationResult<{ result: OperationResult; replayed: boolean }> {
  if (
    !isExecutionAdmitted(authority, {
      kind: 'operation',
      execution_digest: journal.execution_digest,
      context,
      operation,
    })
  )
    return invalid(
      'UNTRUSTED_EXECUTION_INPUT',
      'Independent authority must admit the exact actor, snapshot, observations, and operation.',
    );
  const time = contextTime(context);
  if (!time.ok) return time;
  if (!same(context.actor, operation.actor))
    return invalid('ACTOR_MISMATCH', 'Authenticated actor must match the operation.');
  const request = journal.execution.action_request;
  const controlOperation = ['cancel', 'invalidate', 'expire', 'reconcile', 'resolve_conflict'].includes(
    operation.command.kind,
  );
  // The independently admitted control operation still targets the original request.
  // Drift must prevent new work without preventing closure or recovery of old work.
  if (
    !controlOperation &&
    (context.snapshot.binding.workflow_run_id !== request.request.binding.workflow_run_id ||
      context.snapshot.binding.graph_digest !== request.request.binding.graph_digest)
  )
    return invalid('CONTEXT_BINDING_MISMATCH', 'Context must belong to the original Workflow Run and graph.');
  const digest = executionDigest(operation);
  const known = index.operations.get(operation.id);
  const command = operation.command;
  const collisions: IdentityCollision[] = [];
  if (known && known.digest !== digest)
    collisions.push({
      namespace: 'operation',
      identity: operation.id,
      original_digest: known.digest,
      incoming_digest: digest,
    });
  collisions.push(...observationConflicts(index.observations, contextObservations(context)));
  if (collisions.length === 0 && known) return { ok: true, value: { result: known.result, replayed: true } };
  const priorConflicts = collisions.map((item) =>
    state.conflicts.find(
      (record) =>
        record.id === executionDigest([item.namespace, item.identity, item.original_digest, item.incoming_digest]),
    ),
  );
  if (known && priorConflicts.length > 0 && priorConflicts.every((item) => item !== undefined))
    return { ok: true, value: { result: priorConflicts[0]!.result, replayed: true } };
  if (time.value < state.evaluated_at) return invalid('TIME_REVERSED', 'Authority time cannot move backwards.');
  state.revision += 1;
  state.evaluated_at = time.value;
  rememberObservations(index, context);
  if (collisions.length > 0) {
    const results = collisions.map((item) =>
      conflict(state, item.namespace, item.identity, item.original_digest, item.incoming_digest),
    );
    const result = results[0]!;
    if (!known) {
      rememberOperation(index, state, operation, digest, result);
      retainReceipt(state, command, result);
    }
    return { ok: true, value: { result, replayed: false } };
  }
  const result = execute(journal, state, context, operation, time.value, index);
  retainReceipt(state, command, result);
  rememberOperation(index, state, operation, digest, result);
  return { ok: true, value: { result, replayed: false } };
}

function retainReceipt(
  state: ExecutionProjection,
  command: ExecutionOperation['command'],
  result: OperationResult,
): void {
  if (
    command.kind === 'submit_receipt' &&
    !state.receipts.some((record) => record.envelope.receipt.id === command.receipt.receipt.id)
  ) {
    state.receipts.push({ envelope: command.receipt, result });
  }
}

function outcome(
  code: string,
  revision: number,
  disposition: OperationResult['disposition'] = 'rejected',
): OperationResult {
  return {
    disposition,
    code,
    revision,
    claim: null,
    attempt_id: null,
    recovery:
      disposition === 'applied'
        ? 'Commit the complete proposal against its expected journal digest before acknowledging; recheck current authority before work.'
        : code === 'IDENTITY_CONFLICT'
          ? 'Retain both contents. A current human authority must resolve the conflict against the original digest; never overwrite history.'
          : 'Inspect the retained disposition and current execution. Refresh bindings or reconcile with independent evidence; never repeat an uncertain effect.',
  };
}

function conflict(
  state: ExecutionProjection,
  namespace: ExecutionProjection['conflicts'][number]['namespace'],
  identity: string,
  original: string,
  incoming: string,
): OperationResult {
  const id = executionDigest([namespace, identity, original, incoming]);
  const existing = state.conflicts.find((record) => record.id === id);
  if (existing) return existing.result;
  const result = outcome('IDENTITY_CONFLICT', state.revision, 'conflict');
  state.conflicts.push({
    id,
    namespace,
    identity,
    original_digest: original,
    incoming_digest: incoming,
    resolved_by: null,
    result,
  });
  return result;
}

function execute(
  journal: ExecutionJournal,
  state: ExecutionProjection,
  context: ExecutionContext,
  operation: ExecutionOperation,
  now: string,
  index: ReplayIndex,
): OperationResult {
  const fail = (code: string) => outcome(code, state.revision);
  const applied = (code: string) => outcome(code, state.revision, 'applied');
  const command = operation.command;
  const request = journal.execution.action_request;
  const policy = journal.execution.execution_policy;
  if (
    !same(operation.request, requestReference(request)) ||
    !same(operation.binding, request.request.binding) ||
    !same(operation.execution_policy, { id: policy.id, digest: policy.digest })
  )
    return fail('OPERATION_BINDING_MISMATCH');

  if (command.kind === 'register_request') {
    if (!controlActor(context, 'threadloop')) return fail('AUTHORITY_MISMATCH');
    if (command.request.request.idempotency_key !== request.request.idempotency_key)
      return fail('REQUEST_SLOT_MISMATCH');
    const checked = validateRequestInSnapshot(context.snapshot, command.request, 'in_flight');
    if (!checked.ok && checked.diagnostics.some((item) => item.code !== 'IDEMPOTENCY_CONFLICT'))
      return fail('INVALID_REQUEST_CANDIDATE');
    if (!same(command.request, request))
      return conflict(
        state,
        'request',
        request.request.idempotency_key,
        request.request_digest,
        command.request.request_digest,
      );
    return applied('REQUEST_ALREADY_REGISTERED');
  }
  // A repeated submission returns its historical disposition, never fresh claim authority.
  if (command.kind === 'submit_receipt') {
    const previous = state.receipts.find((record) => record.envelope.receipt.id === command.receipt.receipt.id);
    if (previous)
      return same(previous.envelope, command.receipt)
        ? previous.result
        : conflict(
            state,
            'receipt',
            command.receipt.receipt.id,
            executionDigest(previous.envelope),
            executionDigest(command.receipt),
          );
    if (context.actor.kind !== 'executor' || !same(context.actor.executor, command.receipt.receipt.executor))
      return fail('EXECUTOR_MISMATCH');
  }
  if (command.kind === 'acquire' || command.kind === 'replace') {
    if (context.actor.kind !== 'executor' || !same(context.actor.executor, command.executor))
      return fail('EXECUTOR_MISMATCH');
    const previous = index.grantsByClaim.get(command.claim_id);
    if (previous)
      return same(previous.operation.command, command) && same(previous.operation.actor, operation.actor)
        ? previous.result
        : conflict(
            state,
            'claim',
            command.claim_id,
            executionDigest(previous.operation.command),
            executionDigest(command),
          );
    const attemptGrant = index.grantsByAttempt.get(command.attempt_id);
    if (attemptGrant)
      return conflict(
        state,
        'attempt',
        command.attempt_id,
        executionDigest(attemptGrant.command),
        executionDigest(command),
      );
  }
  if (
    operation.expected_revision !== state.revision - 1 ||
    operation.expected_execution_digest !== journal.execution_digest
  )
    return fail('EXECUTION_VERSION_CONFLICT');
  if (command.kind === 'resolve_conflict') {
    if (!controlActor(context, 'human')) return fail('HUMAN_AUTHORITY_REQUIRED');
    const record = state.conflicts.find((record) => record.id === command.conflict_id);
    if (!record || record.original_digest !== command.original_digest) return fail('CONFLICT_BINDING_MISMATCH');
    if (record.resolved_by !== null) return fail('CONFLICT_ALREADY_RESOLVED');
    record.resolved_by = operation.id;
    return applied('CONFLICT_RESOLVED');
  }
  if (command.kind === 'cancel' || command.kind === 'invalidate') {
    if (!controlActor(context, 'threadloop') && !controlActor(context, 'human')) return fail('AUTHORITY_MISMATCH');
    if (
      command.kind === 'invalidate' &&
      command.reason === 'binding_changed' &&
      same(request.request.binding, context.snapshot.binding)
    )
      return fail('INVALIDATION_NOT_ESTABLISHED');
    if (
      command.kind === 'invalidate' &&
      command.reason === 'request_expired' &&
      !deadlinePassed(request.request.constraints.valid_until, now)
    )
      return fail('INVALIDATION_NOT_ESTABLISHED');
    const integrityFailure = command.kind === 'invalidate' && command.reason === 'integrity_failure';
    if (state.request_status !== 'open' && !integrityFailure) return fail('REQUEST_CLOSED');
    state.request_status = command.kind === 'cancel' ? 'cancelled' : 'invalidated';
    for (const claim of state.claims) {
      if (integrityFailure && !state.invalidated_claims.some((item) => same(item, reference(claim))))
        state.invalidated_claims.push(reference(claim));
      if (claim.status === 'active')
        close(
          claim,
          state.attempts.find((attempt) => attempt.id === claim.attempt_id)!,
          command.kind === 'cancel' ? 'cancelled' : 'invalidated',
          now,
        );
    }
    return applied(command.kind === 'cancel' ? 'REQUEST_CANCELLED' : 'REQUEST_INVALIDATED');
  }
  if (command.kind === 'reconcile') return reconcile(journal, state, context, operation, now);
  if (command.kind === 'submit_receipt') return submit(journal, state, context, command.receipt, now);
  if (command.kind === 'expire') {
    if (!controlActor(context, 'threadloop')) return fail('AUTHORITY_MISMATCH');
    const claim = state.claims.find(
      (claim) => same(reference(claim), command.claim) && claim.attempt_id === command.attempt_id,
    );
    if (!claim || claim.status !== 'active') return fail('CLAIM_NOT_CURRENT');
    if (!deadlinePassed(claim.valid_until, now)) return fail('CLAIM_NOT_EXPIRED');
    close(
      claim,
      state.attempts.find((attempt) => attempt.id === claim.attempt_id)!,
      'expired',
      now,
    );
    return applied('CLAIM_EXPIRED');
  }
  if (state.conflicts.some((record) => record.resolved_by === null)) return fail('UNRESOLVED_CONFLICT');
  if (state.request_status !== 'open') return fail('REQUEST_CLOSED');
  if (!validateRequestInSnapshot(context.snapshot, request, 'in_flight').ok) return fail('REQUEST_NOT_CURRENT');
  if (context.snapshot.execution.status !== 'idle' && !same(context.snapshot.execution.request, request))
    return fail('OTHER_EXECUTION_OUTSTANDING');
  if (command.kind === 'acquire' || command.kind === 'replace') return acquire(journal, state, context, operation, now);
  const claim = state.claims.find(
    (claim) => same(reference(claim), command.claim) && claim.attempt_id === command.attempt_id,
  );
  if (!claim || fenced(claim, context.snapshot, now)) return fail('CLAIM_FENCED');
  if (context.actor.kind !== 'executor' || !same(context.actor.executor, claim.executor))
    return fail('EXECUTOR_MISMATCH');
  const attempt = state.attempts.find((attempt) => attempt.id === claim.attempt_id)!;
  if (command.kind === 'renew') {
    if (!validDeadline(command.valid_until, now, request) || command.valid_until <= claim.valid_until)
      return fail('INVALID_CLAIM_DEADLINE');
    claim.valid_until = command.valid_until;
    claim.renewed_at = now;
    return { ...applied('CLAIM_RENEWED'), claim: reference(claim), attempt_id: attempt.id };
  }
  if (command.kind === 'start') {
    if (attempt.status !== 'pending') return fail('ATTEMPT_ALREADY_STARTED');
    attempt.status = 'running';
    attempt.started_at = now;
    attempt.effect = 'unknown';
    return { ...applied('ATTEMPT_STARTED'), claim: reference(claim), attempt_id: attempt.id };
  }
  close(claim, attempt, 'released', now);
  return applied('CLAIM_RELEASED');
}

function reference(claim: ExecutionClaim) {
  return { id: claim.id, version: claim.version };
}
function deadlinePassed(deadline: string | null, now: string): boolean {
  return deadline !== null && now >= deadline;
}
function fenced(claim: ExecutionClaim, snapshot: ControllerInput, now: string): boolean {
  return (
    claim.status !== 'active' ||
    deadlinePassed(claim.valid_until, now) ||
    snapshot.invalidated_claims.some((item) => same(item, reference(claim)))
  );
}
function realTime(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function validDeadline(deadline: string, now: string, request: ActionRequest): boolean {
  return (
    realTime(deadline) &&
    deadline > now &&
    (request.request.constraints.valid_until === null || deadline <= request.request.constraints.valid_until)
  );
}
function close(claim: ExecutionClaim, attempt: Attempt, status: ExecutionClaim['status'], now: string): void {
  claim.status = status;
  claim.closed_at = now;
  if (attempt.status === 'pending' || attempt.status === 'running') {
    attempt.status =
      attempt.started_at === null ? (status === 'cancelled' ? 'cancelled' : 'interrupted') : 'unknown_outcome';
    attempt.ended_at = now;
  }
}

function acquire(
  journal: ExecutionJournal,
  state: ExecutionProjection,
  context: ExecutionContext,
  operation: ExecutionOperation,
  now: string,
): OperationResult {
  const command = operation.command;
  if (command.kind !== 'acquire' && command.kind !== 'replace') throw new Error('Invalid grant dispatch');
  const fail = (code: string) => outcome(code, state.revision);
  if (state.claims.some((claim) => claim.status === 'active')) return fail('CLAIM_HELD');
  const previous = state.claims.at(-1);
  if ((command.kind === 'acquire') !== (previous === undefined)) return fail('REPLACEMENT_REQUIRED');
  if (
    context.snapshot.invalidated_claims.some((item) =>
      same(item, { id: command.claim_id, version: (previous?.version ?? 0) + 1 }),
    )
  )
    return fail('CLAIM_FENCED');
  if (command.kind === 'replace') {
    if (!previous || !same(command.previous_claim, reference(previous))) return fail('PREVIOUS_CLAIM_MISMATCH');
    const attempt = state.attempts.find((attempt) => attempt.id === previous.attempt_id)!;
    const evidence = recoveryFacts(journal, context, previous, attempt, command.evidence_ids, now);
    if (!evidence.ok) return fail(evidence.diagnostics[0]!.code);
    const safety = journal.execution.execution_policy.rules.retry_safety;
    const knownNoEffect =
      !evidence.value.effect_observed &&
      (attempt.started_at === null ||
        attempt.resolution?.disposition === 'no_effect_confirmed' ||
        (attempt.receipt_id !== null && attempt.effect === 'none'));
    const repeatable =
      safety === 'repeatable_with_overlap' ||
      (safety === 'repeatable_after_stop' && evidence.value.selected.some((item) => item.kind === 'executor_stopped'));
    if (attempt.resolution?.disposition === 'abandon' || (!knownNoEffect && !repeatable))
      return fail('RECONCILIATION_REQUIRED');
  }
  if (state.attempts.length >= journal.execution.execution_policy.rules.max_attempts)
    return fail('ATTEMPT_LIMIT_REACHED');
  if (!validDeadline(command.valid_until, now, journal.execution.action_request)) return fail('INVALID_CLAIM_DEADLINE');
  const claim: ExecutionClaim = {
    schema_version: '0.1',
    id: command.claim_id,
    version: (previous?.version ?? 0) + 1,
    request: operation.request,
    binding: operation.binding,
    execution_policy: operation.execution_policy,
    executor: command.executor,
    attempt_id: command.attempt_id,
    status: 'active',
    acquired_at: now,
    renewed_at: null,
    valid_until: command.valid_until,
    closed_at: null,
  };
  if (previous) previous.status = 'replaced';
  state.claims.push(claim);
  state.attempts.push({
    schema_version: '0.1',
    id: command.attempt_id,
    request: operation.request,
    binding: operation.binding,
    execution_policy: operation.execution_policy,
    claim: reference(claim),
    executor: command.executor,
    status: 'pending',
    effect: 'not_started',
    created_at: now,
    started_at: null,
    ended_at: null,
    receipt_id: null,
    resulting_subject: null,
    resolution: null,
  });
  return {
    ...outcome('CLAIM_ACQUIRED', state.revision, 'applied'),
    claim: reference(claim),
    attempt_id: command.attempt_id,
  };
}

function submit(
  journal: ExecutionJournal,
  state: ExecutionProjection,
  context: ExecutionContext,
  envelope: AttemptReceipt,
  now: string,
): OperationResult {
  const receipt = envelope.receipt;
  const fail = (code: string) => outcome(code, state.revision);
  let result: OperationResult;
  const claim = state.claims.find((claim) => same(reference(claim), receipt.claim));
  const attempt = state.attempts.find((attempt) => attempt.id === receipt.attempt_id);
  if (
    envelope.receipt_digest !== executionDigest(receipt) ||
    !same(receipt.request, requestReference(journal.execution.action_request)) ||
    !same(receipt.binding, journal.execution.action_request.request.binding) ||
    !same(receipt.execution_policy, {
      id: journal.execution.execution_policy.id,
      digest: journal.execution.execution_policy.digest,
    }) ||
    !claim ||
    !attempt ||
    claim.attempt_id !== attempt.id ||
    !same(claim.executor, receipt.executor)
  )
    result = fail('RECEIPT_BINDING_MISMATCH');
  else if (fenced(claim, context.snapshot, now) || state.request_status !== 'open') result = fail('CLAIM_FENCED');
  else if (state.conflicts.some((record) => record.resolved_by === null)) result = fail('UNRESOLVED_CONFLICT');
  else if (!validateRequestInSnapshot(context.snapshot, journal.execution.action_request, 'in_flight').ok)
    result = fail('REQUEST_NOT_CURRENT');
  else if (
    attempt.status !== 'running' ||
    attempt.started_at === null ||
    receipt.finished_at < attempt.started_at ||
    receipt.finished_at > now ||
    !realTime(receipt.finished_at) ||
    !sameSubjectIdentity(receipt.resulting_subject, receipt.binding.subject) ||
    new Set(receipt.evidence.map((item) => item.id)).size !== receipt.evidence.length ||
    (receipt.status === 'succeeded' && (receipt.effect === 'unknown' || receipt.evidence.length === 0)) ||
    (receipt.effect === 'none' &&
      receipt.resulting_subject !== null &&
      !same(receipt.resulting_subject, receipt.binding.subject))
  )
    result = fail('INVALID_ATTEMPT_OUTCOME');
  else if (!admittedReceipt(context, envelope, now)) result = fail('RECEIPT_ADMISSION_MISMATCH');
  else {
    attempt.status = receipt.effect === 'unknown' ? 'unknown_outcome' : receipt.status;
    attempt.effect = receipt.effect;
    attempt.ended_at = receipt.finished_at;
    attempt.receipt_id = receipt.id;
    attempt.resulting_subject = receipt.resulting_subject;
    claim.status = 'completed';
    claim.closed_at = now;
    if (receipt.status === 'succeeded') state.request_status = 'satisfied';
    result = {
      ...outcome('RECEIPT_ACCEPTED', state.revision, 'applied'),
      claim: reference(claim),
      attempt_id: attempt.id,
    };
  }
  return result;
}

function admittedReceipt(context: ExecutionContext, envelope: AttemptReceipt, now: string): boolean {
  const receipt = envelope.receipt;
  const matches = context.receipt_admissions.filter((item) => item.admission.receipt.id === receipt.id);
  const admitted = matches[0];
  // Repeated transport copies of the same immutable admission are harmless.
  if (!admitted || matches.some((item) => !same(item, admitted))) return false;
  const fact = admitted.admission;
  return (
    admitted.admission_digest === executionDigest(fact) &&
    fact.receipt.digest === envelope.receipt_digest &&
    same(fact.request, receipt.request) &&
    same(fact.binding, receipt.binding) &&
    same(fact.execution_policy, receipt.execution_policy) &&
    same(fact.claim, receipt.claim) &&
    fact.attempt_id === receipt.attempt_id &&
    same(fact.executor, receipt.executor) &&
    context.snapshot.policy.rules.evidence_policies.some((policy) => same(policy, fact.verification_policy)) &&
    realTime(fact.admitted_at) &&
    fact.admitted_at >= receipt.finished_at &&
    fact.admitted_at <= now &&
    (fact.valid_until === null || (realTime(fact.valid_until) && fact.valid_until > now))
  );
}

function recoveryFacts(
  journal: ExecutionJournal,
  context: ExecutionContext,
  claim: ExecutionClaim,
  attempt: Attempt,
  ids: string[],
  now: string,
): ValidationResult<{ selected: RecoveryEvidence['evidence'][]; effect_observed: boolean }> {
  if (new Set(ids).size !== ids.length)
    return invalid('RECOVERY_EVIDENCE_MISMATCH', 'Duplicate observation references.');
  const facts: RecoveryEvidence['evidence'][] = [];
  for (const id of ids) {
    const matches = context.recovery_evidence.filter((item) => item.evidence.id === id);
    if (matches.length === 0 || matches.some((item) => !same(item, matches[0])))
      return invalid('RECOVERY_EVIDENCE_MISMATCH', 'Each observation must resolve to one immutable value.');
    const envelope = matches[0]!;
    const fact = envelope.evidence;
    if (!validRecoveryFact(envelope, context, claim, attempt, now))
      return invalid(
        'RECOVERY_EVIDENCE_MISMATCH',
        'Recovery observations must bind this exact closed Attempt and accepted verification policy.',
      );
    facts.push(fact);
  }
  const allKinds = new Set(facts.map((fact) => fact.kind));
  const contexts = [
    journal.execution.initial_context,
    ...journal.execution.entries.map((entry) => entry.context),
    context,
  ];
  for (const admitted of contexts) {
    const observedAt = admitted.snapshot.evaluation_time;
    if (observedAt === null) continue;
    for (const envelope of admitted.recovery_evidence)
      if (validRecoveryFact(envelope, admitted, claim, attempt, observedAt)) allKinds.add(envelope.evidence.kind);
  }
  if (attempt.effect === 'occurred') allKinds.add('effect_occurred');
  if (attempt.effect === 'none' || attempt.resolution?.disposition === 'no_effect_confirmed') allKinds.add('no_effect');
  if (attempt.resolution?.disposition === 'effect_confirmed') allKinds.add('effect_occurred');
  if (allKinds.has('effect_occurred') && allKinds.has('no_effect'))
    return invalid(
      'RECOVERY_EVIDENCE_CONTRADICTORY',
      'Retained or current observations disagree about this Attempt; selecting fewer references cannot authorize retry.',
    );
  return { ok: true, value: { selected: facts, effect_observed: allKinds.has('effect_occurred') } };
}

function validRecoveryFact(
  envelope: RecoveryEvidence,
  context: ExecutionContext,
  claim: ExecutionClaim,
  attempt: Attempt,
  now: string,
): boolean {
  const fact = envelope.evidence;
  return !(
    envelope.evidence_digest !== executionDigest(fact) ||
    !same(fact.request, claim.request) ||
    !same(fact.binding, claim.binding) ||
    !same(fact.execution_policy, claim.execution_policy) ||
    !same(fact.claim, reference(claim)) ||
    fact.attempt_id !== attempt.id ||
    !same(fact.executor, claim.executor) ||
    fact.observed_at < (claim.closed_at ?? claim.acquired_at) ||
    fact.observed_at > now ||
    !realTime(fact.observed_at) ||
    !sameSubjectIdentity(fact.resulting_subject, claim.binding.subject) ||
    !context.snapshot.policy.rules.evidence_policies.some((policy) => same(policy, fact.verification_policy)) ||
    (fact.kind !== 'effect_occurred' && fact.resulting_subject !== null)
  );
}

function sameSubjectIdentity(
  result: ControllerInput['binding']['subject'] | null,
  original: ControllerInput['binding']['subject'],
): boolean {
  if (result === null) return true;
  if (result.kind === 'repository' && original.kind === 'repository')
    return result.repository_id === original.repository_id;
  if (result.kind === 'artifact' && original.kind === 'artifact') return result.artifact_id === original.artifact_id;
  return false;
}

function reconcile(
  journal: ExecutionJournal,
  state: ExecutionProjection,
  context: ExecutionContext,
  operation: ExecutionOperation,
  now: string,
): OperationResult {
  const command = operation.command;
  if (command.kind !== 'reconcile') throw new Error('Invalid recovery dispatch');
  const fail = (code: string) => outcome(code, state.revision);
  if (!controlActor(context, 'human') || context.actor.kind !== 'human') return fail('HUMAN_AUTHORITY_REQUIRED');
  const claim = state.claims.find(
    (claim) => same(reference(claim), command.claim) && claim.attempt_id === command.attempt_id,
  );
  const attempt = state.attempts.find((attempt) => attempt.id === command.attempt_id);
  if (!claim || !attempt || claim.status === 'active' || attempt.resolution !== null || attempt.status === 'succeeded')
    return fail('ATTEMPT_NOT_RECONCILABLE');
  const evidence = recoveryFacts(journal, context, claim, attempt, command.evidence_ids, now);
  if (!evidence.ok) return fail(evidence.diagnostics[0]!.code);
  const kinds = evidence.value.selected.map((fact) => fact.kind);
  if (!kinds.includes('executor_stopped') || (kinds.includes('no_effect') && kinds.includes('effect_occurred')))
    return fail('RECOVERY_EVIDENCE_INSUFFICIENT');
  if (command.disposition === 'effect_confirmed' && !kinds.includes('effect_occurred'))
    return fail('RECOVERY_EVIDENCE_INSUFFICIENT');
  if (command.disposition === 'no_effect_confirmed' && (!kinds.includes('no_effect') || attempt.effect === 'occurred'))
    return fail('RECOVERY_EVIDENCE_INSUFFICIENT');
  attempt.resolution = {
    operation_id: operation.id,
    disposition: command.disposition,
    evidence_ids: command.evidence_ids,
    operator: context.actor.identity,
    resolved_at: now,
  };
  if (
    (command.disposition === 'effect_confirmed' || command.disposition === 'abandon') &&
    state.request_status === 'open'
  ) {
    state.request_status = command.disposition === 'effect_confirmed' ? 'satisfied' : 'cancelled';
    for (const current of state.claims)
      if (current.status === 'active')
        close(
          current,
          state.attempts.find((item) => item.id === current.attempt_id)!,
          'cancelled',
          now,
        );
  }
  return outcome('ATTEMPT_RECONCILED', state.revision, 'applied');
}
