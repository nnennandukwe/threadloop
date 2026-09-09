import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { readFile } from 'node:fs/promises';
import { controllerInputSchema, controllerDecisionSchema } from '../../scripts/controller-contract/contracts.js';
import { buildActionRequest } from '../../scripts/controller-contract/request.js';
import { controllerSnapshot, localProofIntent } from './controller-contract.js';
import type {
  ExecutionContext,
  ExecutionPolicy,
  ExecutionJournal,
  ExecutionOperation,
  AttemptReceipt,
  ReceiptAdmission,
  RecoveryEvidence,
} from '../../scripts/execution-contract/contracts.js';
import {
  applyExecutionOperation,
  createExecutionJournal,
  executionDigest,
  requestReference,
} from '../../scripts/execution-contract/model.js';

export async function executionFixture(profile: 'governed-pr' | 'release-to-publish' = 'governed-pr') {
  let snapshot = await controllerSnapshot(profile);
  snapshot.evaluation_time = '2026-09-10T10:00:00.000Z';
  let built = buildActionRequest(snapshot, localProofIntent(snapshot));
  if (profile === 'release-to-publish') {
    const fixture = JSON.parse(
      await readFile(
        new URL('../../docs/contracts/controller-v0.1/fixtures/valid/release_publication.json', import.meta.url),
        'utf8',
      ),
    ) as { input: unknown; expected: unknown };
    snapshot = controllerInputSchema.parse({
      ...controllerInputSchema.omit({ compiled_graph: true }).parse(fixture.input),
      compiled_graph: snapshot.compiled_graph,
    });
    snapshot.evaluation_time = '2026-09-10T10:00:00.000Z';
    const decision = controllerDecisionSchema.parse(fixture.expected).decision;
    if (decision.outcome !== 'engineering_action_required') throw new Error('Expected executor publication fixture');
    built = { ok: true, value: decision.action_request };
  }
  if (!built.ok) throw new Error(JSON.stringify(built));
  const request = built.value;
  const rules: ExecutionPolicy['rules'] = {
    request: { idempotency_key: request.request.idempotency_key, request_digest: request.request_digest },
    workflow_policy: request.request.policy,
    retry_safety: 'reconciliation_required',
    max_attempts: 3,
  };
  const policy: ExecutionPolicy = { id: 'execution_policy', digest: sha256(canonicalJson(rules)), rules };
  const context: ExecutionContext = {
    snapshot,
    actor: { kind: 'threadloop', identity: snapshot.policy.rules.authorities[0]!.identity },
    recovery_evidence: [],
    receipt_admissions: [],
  };
  return { context, request, policy };
}

export const executorA = { id: 'executor_a', incarnation: 'process_a' };
export const executorB = { id: 'executor_b', incarnation: 'process_b' };
export const target = { claim: { id: 'claim_a', version: 1 }, attempt_id: 'attempt_a' };
export const grant: Extract<ExecutionOperation['command'], { kind: 'acquire' }> = {
  kind: 'acquire',
  claim_id: 'claim_a',
  attempt_id: 'attempt_a',
  executor: executorA,
  valid_until: '2026-09-10T10:05:00.000Z',
};

export async function initialExecution(
  retry: ExecutionPolicy['rules']['retry_safety'] = 'reconciliation_required',
  profile: 'governed-pr' | 'release-to-publish' = 'governed-pr',
) {
  const fixture = await executionFixture(profile);
  fixture.policy.rules.retry_safety = retry;
  fixture.policy.digest = executionDigest(fixture.policy.rules);
  const created = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
  if (!created.ok) throw new Error(JSON.stringify(created));
  return { ...fixture, journal: created.value };
}

export function operationFor(
  journal: ExecutionJournal,
  actor: ExecutionContext['actor'],
  command: ExecutionOperation['command'],
  id = `operation_${journal.execution.entries.length}`,
): ExecutionOperation {
  return structuredClone({
    schema_version: '0.1',
    id,
    actor,
    command,
    expected_revision: journal.execution.entries.length,
    expected_execution_digest: journal.execution_digest,
    request: requestReference(journal.execution.action_request),
    binding: journal.execution.action_request.request.binding,
    execution_policy: { id: journal.execution.execution_policy.id, digest: journal.execution.execution_policy.digest },
  });
}

export function operate(
  journal: ExecutionJournal,
  command: ExecutionOperation['command'],
  actor: ExecutionContext['actor'] = { kind: 'executor', executor: executorA },
  time = '2026-09-10T10:00:00.000Z',
  evidence: RecoveryEvidence[] = [],
  admissions?: ReceiptAdmission[],
) {
  const context = structuredClone(journal.execution.initial_context);
  context.actor = actor;
  context.snapshot.evaluation_time = time;
  context.recovery_evidence = evidence;
  // Test-only admitted context; raw/untrusted-report tests pass [] explicitly.
  context.receipt_admissions =
    admissions ?? (command.kind === 'submit_receipt' ? [receiptAdmissionFor(journal, command.receipt)] : []);
  const operation = operationFor(journal, actor, command);
  const result = applyExecutionOperation(journal, context, operation);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return { ...result.value, context, operation };
}

export function controllerActor(journal: ExecutionJournal): ExecutionContext['actor'] {
  return journal.execution.initial_context.actor;
}

export function humanActor(journal: ExecutionJournal): ExecutionContext['actor'] {
  return {
    kind: 'human',
    identity: journal.execution.initial_context.snapshot.policy.rules.authorities.find(
      (authority) => authority.type === 'human',
    )!.identity,
  };
}

export function receiptFor(
  journal: ExecutionJournal,
  changes: Partial<AttemptReceipt['receipt']> = {},
): AttemptReceipt {
  const receipt: AttemptReceipt['receipt'] = {
    schema_version: '0.1',
    id: 'receipt_a',
    ...target,
    executor: executorA,
    request: requestReference(journal.execution.action_request),
    binding: journal.execution.action_request.request.binding,
    execution_policy: { id: journal.execution.execution_policy.id, digest: journal.execution.execution_policy.digest },
    status: 'succeeded',
    effect: 'none',
    resulting_subject: null,
    finished_at: '2026-09-10T10:01:00.000Z',
    evidence: [{ id: 'local_proof', digest: executionDigest('proof') }],
    ...changes,
  };
  return { receipt, receipt_digest: executionDigest(receipt) };
}

export function recoveryFor(journal: ExecutionJournal, kind: RecoveryEvidence['evidence']['kind']): RecoveryEvidence {
  const evidence: RecoveryEvidence['evidence'] = {
    schema_version: '0.1',
    id: kind,
    ...target,
    executor: executorA,
    request: requestReference(journal.execution.action_request),
    binding: journal.execution.action_request.request.binding,
    execution_policy: { id: journal.execution.execution_policy.id, digest: journal.execution.execution_policy.digest },
    kind,
    observed_at: '2026-09-10T10:06:00.000Z',
    resulting_subject: null,
    verification_policy: journal.execution.initial_context.snapshot.policy.rules.evidence_policies[0]!,
    acceptance: { id: `accepted_${kind}`, digest: executionDigest(kind) },
  };
  return { evidence, evidence_digest: executionDigest(evidence) };
}

export function receiptAdmissionFor(
  journal: ExecutionJournal,
  envelope: AttemptReceipt,
  time = envelope.receipt.finished_at,
): ReceiptAdmission {
  const report = envelope.receipt;
  const admission: ReceiptAdmission['admission'] = {
    schema_version: '0.1',
    id: `admission_${report.id}_${envelope.receipt_digest}`,
    request: report.request,
    binding: report.binding,
    execution_policy: report.execution_policy,
    claim: report.claim,
    attempt_id: report.attempt_id,
    executor: report.executor,
    receipt: { id: report.id, digest: envelope.receipt_digest },
    verification_policy: journal.execution.initial_context.snapshot.policy.rules.evidence_policies[0]!,
    acceptance: { id: `accepted_${report.id}`, digest: executionDigest(['accepted', envelope.receipt_digest]) },
    admitted_at: time,
    valid_until: null,
  };
  return structuredClone({ admission, admission_digest: executionDigest(admission) });
}
