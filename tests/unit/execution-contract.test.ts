import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { digest } from '../../scripts/contract-kernel/kernel.js';
import { validateControllerDecision } from '../../scripts/controller-contract/decision.js';
import type { ControllerDecision } from '../../scripts/controller-contract/contracts.js';
import {
  publishedExecutionSchemas,
  type ExecutionOperation,
  type ExecutionContext,
  type RecoveryEvidence,
  type ReceiptAdmission,
} from '../../scripts/execution-contract/contracts.js';
import { replayExecutionJournal as replayWith } from '../../scripts/execution-contract/model.js';
import {
  applyExecutionOperation,
  createExecutionJournal,
  replayExecutionJournal,
  projectControllerExecution,
  executionFixture,
  initialExecution,
  operate,
  operationFor,
  executorA,
  executorB,
  executorBActor,
  grant,
  target,
  receiptFor,
  controllerActor,
  humanActor,
  recoveryFor,
  receiptAdmissionFor,
  startAttempt,
  expireClaim,
  replaceClaim,
  reconcileCommand,
  submitReceipt,
} from '../fixtures/execution-contract.js';
import { codes, publishedValidators } from '../fixtures/contracts.js';

const late = '2026-09-10T10:05:00.000Z';
const later = '2026-09-10T10:06:00.000Z';

describe('Execution admission', () => {
  it('reserves a rejected report identity even when its submitter is not the bound executor', async () => {
    const { journal } = await initialExecution();
    const started = startAttempt(journal);
    const receipt = receiptFor(journal);
    const rejected = submitReceipt(started.journal, receipt, undefined, [], executorBActor);
    expect(rejected.result.code).toBe('EXECUTOR_MISMATCH');
    expect(rejected.projection.receipts).toEqual([{ envelope: receipt, result: rejected.result }]);
    const exact = submitReceipt(rejected.journal, receipt);
    expect(exact.result).toEqual(rejected.result);
    const changed = submitReceipt(exact.journal, receiptFor(journal, { status: 'failed' }));
    expect(changed.result.code).toBe('IDENTITY_CONFLICT');
    expect(changed.projection.conflicts[0]?.namespace).toBe('receipt');
    expect(changed.projection.attempts).toEqual(started.projection.attempts);
  });

  it.each(['receipt_admissions', 'recovery_evidence'] as const)(
    'rejects contradictory initial %s while allowing exact duplicate copies',
    async (kind) => {
      const fixture = await initialExecution();
      if (kind === 'receipt_admissions') {
        const record = receiptAdmissionFor(fixture.journal, receiptFor(fixture.journal));
        fixture.context.receipt_admissions = [record, structuredClone(record)];
      } else {
        const record = recoveryFor(fixture.journal, 'executor_stopped');
        fixture.context.recovery_evidence = [record, structuredClone(record)];
      }
      expect(createExecutionJournal(fixture.context, fixture.request, fixture.policy).ok).toBe(true);
      if (kind === 'receipt_admissions') {
        const record = fixture.context.receipt_admissions[1]!;
        record.admission.acceptance.digest = digest('different');
        record.admission_digest = digest(record.admission);
      } else {
        const record = fixture.context.recovery_evidence[1]!;
        record.evidence.kind = 'effect_occurred';
        record.evidence_digest = digest(record.evidence);
      }
      expect(codes(createExecutionJournal(fixture.context, fixture.request, fixture.policy))).toEqual([
        'INITIAL_EVIDENCE_CONFLICT',
      ]);
      const tampered = structuredClone(fixture.journal);
      tampered.execution.initial_context = fixture.context;
      tampered.execution_digest = digest(tampered.execution);
      expect(codes(replayExecutionJournal(tampered))).toEqual(['INITIAL_EVIDENCE_CONFLICT']);
    },
  );

  it('retains every conflicting observation in a context before any observation is used', async () => {
    const { journal } = await initialExecution();
    const stop = recoveryFor(journal, 'executor_stopped');
    const changedStop = structuredClone(stop);
    changedStop.evidence.kind = 'effect_occurred';
    changedStop.evidence_digest = digest(changedStop.evidence);
    const admission = receiptAdmissionFor(journal, receiptFor(journal));
    const changedAdmission = structuredClone(admission);
    changedAdmission.admission.acceptance.digest = digest('different');
    changedAdmission.admission_digest = digest(changedAdmission.admission);
    const rejected = operate(
      journal,
      grant,
      undefined,
      '2026-09-10T10:00:00.000Z',
      [stop, changedStop],
      [admission, changedAdmission],
    );
    expect(rejected.result.code).toBe('IDENTITY_CONFLICT');
    expect(rejected.projection.conflicts.map((item) => item.namespace)).toEqual([
      'recovery_evidence',
      'receipt_admission',
    ]);
    expect(rejected.projection.claims).toEqual([]);
    const next = operate(rejected.journal, { ...grant, claim_id: 'another', attempt_id: 'another' });
    expect(next.result.code).toBe('UNRESOLVED_CONFLICT');
  });

  it.each(['pending', 'running', 'failed_no_effect'] as const)(
    'closes the request after an older effect is confirmed while replacement is %s',
    async (phase) => {
      const { journal, context } = await initialExecution('repeatable_with_overlap');
      const expired = expireClaim(startAttempt(journal).journal);
      const replacement = { claim: { id: 'claim_b', version: 2 }, attempt_id: 'attempt_b' };
      let current = operate(expired.journal, replaceClaim(), executorBActor, late);
      if (phase !== 'pending')
        current = operate(current.journal, { kind: 'start', ...replacement }, executorBActor, late);
      if (phase === 'failed_no_effect') {
        const failed = receiptFor(journal, {
          ...replacement,
          executor: executorB,
          status: 'failed',
          finished_at: later,
        });
        current = submitReceipt(current.journal, failed, later, undefined, executorBActor);
      }
      const evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'effect_occurred')];
      const confirmed = operate(
        current.journal,
        reconcileCommand('effect_confirmed', evidence, 'Earlier effect independently confirmed'),
        humanActor(journal),
        later,
        evidence,
      );
      expect(confirmed.result.code).toBe('ATTEMPT_RECONCILED');
      expect(confirmed.projection.request_status).toBe('satisfied');
      expect(confirmed.projection.attempts[0]).toMatchObject({
        status: 'unknown_outcome',
        effect: 'unknown',
        resolution: { disposition: 'effect_confirmed' },
      });
      expect(confirmed.projection.claims[1]?.status).toBe(phase === 'failed_no_effect' ? 'completed' : 'cancelled');
      expect(confirmed.projection.attempts[1]?.status).toBe(
        phase === 'running' ? 'unknown_outcome' : phase === 'pending' ? 'cancelled' : 'failed',
      );
      const projected = projectControllerExecution(confirmed.journal, { ...context.snapshot, evaluation_time: later });
      expect(projected.ok && projected.value.execution.status).toBe(
        phase === 'running' ? 'reconciliation_required' : 'idle',
      );
      const retry = operate(
        confirmed.journal,
        replaceClaim({
          previous_claim: replacement.claim,
          claim_id: 'claim_c',
          attempt_id: 'attempt_c',
          executor: executorA,
        }),
        undefined,
        later,
      );
      expect(retry.result.code).toBe('REQUEST_CLOSED');
    },
  );

  it.each(['succeeded', 'failed'] as const)('does not trust a raw %s no-effect report', async (status) => {
    const { journal } = await initialExecution();
    const receipt = receiptFor(journal, { status, evidence: [{ id: 'invented', digest: digest('invented') }] });
    const reported = submitReceipt(startAttempt(journal).journal, receipt, undefined, []);
    expect(reported.result.code).toBe('RECEIPT_ADMISSION_MISMATCH');
    expect(reported.projection.request_status).toBe('open');
    expect(reported.projection.attempts[0]).toMatchObject({ status: 'running', effect: 'unknown', receipt_id: null });
    expect(reported.projection.receipts).toEqual([{ envelope: receipt, result: reported.result }]);
    const retry = operate(expireClaim(reported.journal).journal, replaceClaim(), executorBActor, late);
    expect(retry.result.code).toBe('RECONCILIATION_REQUIRED');
  });

  const admissionChanges: [string, (record: ReceiptAdmission['admission']) => void][] = [
    ['request', (admission) => void (admission.request.request_digest = digest('other request'))],
    ['run', (admission) => void (admission.binding.workflow_run_id = 'other_run')],
    ['graph', (admission) => void (admission.binding.graph_digest = digest('other graph'))],
    ['state', (admission) => void (admission.binding.state_version += 1)],
    ['subject', (admission) => void (admission.binding.subject.content_digest = digest('other subject'))],
    ['execution policy', (admission) => void (admission.execution_policy.digest = digest('other policy'))],
    ['claim', (admission) => void (admission.claim.id = 'other_claim')],
    ['generation', (admission) => void (admission.claim.version += 1)],
    ['Attempt', (admission) => void (admission.attempt_id = 'other_attempt')],
    ['executor', (admission) => void (admission.executor.incarnation = 'other_process')],
    ['receipt ID', (admission) => void (admission.receipt.id = 'other_receipt')],
    ['receipt digest', (admission) => void (admission.receipt.digest = digest('other receipt'))],
    ['verification policy', (admission) => void (admission.verification_policy.digest = digest('other verifier'))],
    ['before report', (admission) => void (admission.admitted_at = '2026-09-10T10:00:00.000Z')],
    ['future admission', (admission) => void (admission.admitted_at = '2026-09-10T10:02:00.000Z')],
    ['expiry boundary', (admission) => void (admission.valid_until = '2026-09-10T10:01:00.000Z')],
  ];
  it.each(admissionChanges)('rejects a resealed admission with mismatched %s', async (_name, change) => {
    const { journal } = await initialExecution();
    const started = startAttempt(journal);
    const receipt = receiptFor(journal);
    const admission = receiptAdmissionFor(journal, receipt);
    change(admission.admission);
    admission.admission_digest = digest(admission.admission);
    const rejected = submitReceipt(started.journal, receipt, undefined, [admission]);
    expect(rejected.result.code).toBe('RECEIPT_ADMISSION_MISMATCH');
    expect(rejected.projection.attempts).toEqual(started.projection.attempts);
    expect(rejected.projection.request_status).toBe('open');
    expect(rejected.journal.execution.entries.at(-1)?.context.receipt_admissions).toEqual([admission]);
  });

  it('rejects bad admission hashes and retains the original rejection after later admission', async () => {
    const { journal } = await initialExecution();
    const started = startAttempt(journal);
    const receipt = receiptFor(journal);
    const admission = receiptAdmissionFor(journal, receipt);
    admission.admission_digest = digest('wrong hash');
    const rejected = submitReceipt(started.journal, receipt, undefined, [admission]);
    expect(rejected.result.code).toBe('RECEIPT_ADMISSION_MISMATCH');
    const corrected = receiptAdmissionFor(journal, receipt);
    corrected.admission.id = 'new_admission';
    corrected.admission_digest = digest(corrected.admission);
    const redelivered = submitReceipt(rejected.journal, receipt, undefined, [corrected]);
    expect(redelivered.result).toEqual(rejected.result);
    expect(redelivered.projection.attempts).toEqual(started.projection.attempts);
    const accepted = submitReceipt(redelivered.journal, receiptFor(journal, { id: 'verified_report' }));
    expect(accepted.result.code).toBe('RECEIPT_ACCEPTED');
  });

  it('deduplicates admitted reports without manufacturing controller guard receipts', async () => {
    const { journal, context } = await initialExecution();
    const receipt = receiptFor(journal);
    const admission = receiptAdmissionFor(journal, receipt);
    const accepted = submitReceipt(startAttempt(journal).journal, receipt, undefined, [
      admission,
      structuredClone(admission),
    ]);
    expect(accepted.result.code).toBe('RECEIPT_ACCEPTED');
    const replayed = applyExecutionOperation(accepted.journal, accepted.context, accepted.operation);
    expect(replayed.ok && replayed.value.journal).toEqual(accepted.journal);
    const projected = projectControllerExecution(accepted.journal, {
      ...context.snapshot,
      evaluation_time: '2026-09-10T10:01:00.000Z',
    });
    expect(projected.ok && projected.value.execution.status).toBe('idle');
    expect(projected.ok && Object.hasOwn(projected.value, 'receipts')).toBe(false);
    expect(accepted.projection.attempts).toHaveLength(1);
    expect(accepted.projection.receipts).toHaveLength(1);
  });

  it.each(['initial', 'entry'] as const)(
    'retains %s admission identities before duplicate operation replay',
    async (location) => {
      const fixture = await initialExecution();
      const original = receiptAdmissionFor(fixture.journal, receiptFor(fixture.journal));
      let journal = fixture.journal;
      if (location === 'initial') {
        fixture.context.receipt_admissions = [original];
        const created = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
        if (!created.ok) throw new Error(JSON.stringify(created));
        journal = created.value;
      }
      const acquired = operate(journal, grant, undefined, '2026-09-10T10:00:00.000Z', [], [original]);
      const changed = structuredClone(acquired.context);
      changed.receipt_admissions[0]!.admission.acceptance.digest = digest('changed acceptance');
      changed.receipt_admissions[0]!.admission_digest = digest(changed.receipt_admissions[0]!.admission);
      const result = applyExecutionOperation(acquired.journal, changed, acquired.operation);
      expect(result.ok && result.value.result.code).toBe('IDENTITY_CONFLICT');
      if (!result.ok) return;
      expect(result.value.projection.conflicts[0]?.namespace).toBe('receipt_admission');
      expect(result.value.projection.attempts).toEqual(acquired.projection.attempts);
      const duplicate = applyExecutionOperation(result.value.journal, changed, acquired.operation);
      expect(duplicate.ok && duplicate.value.journal).toEqual(result.value.journal);
      const anotherOperation = operationFor(result.value.journal, changed.actor, grant, 'another_delivery');
      const another = applyExecutionOperation(result.value.journal, changed, anotherOperation);
      expect(another.ok && another.value.journal.execution.entries.length).toBe(
        result.value.journal.execution.entries.length + 1,
      );
      if (another.ok) expect(another.value.projection.operations.at(-1)?.id).toBe('another_delivery');
    },
  );

  it('does not grant an already invalidated claim identity', async () => {
    const { journal, context } = await initialExecution();
    const actor = { kind: 'executor' as const, executor: executorA };
    const current = structuredClone(context);
    current.actor = actor;
    current.snapshot.invalidated_claims.push(target.claim);
    const result = applyExecutionOperation(journal, current, operationFor(journal, actor, grant));
    expect(result.ok && result.value.result.code).toBe('CLAIM_FENCED');
    if (!result.ok) return;
    expect(result.value.projection.claims).toEqual([]);
    expect(result.value.projection.attempts).toEqual([]);
  });

  it('enforces the admitted attempt limit even when earlier work never started', async () => {
    const fixture = await executionFixture();
    fixture.policy.rules.max_attempts = 1;
    fixture.policy.digest = digest(fixture.policy.rules);
    const created = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
    if (!created.ok) throw new Error(JSON.stringify(created));
    const released = operate(operate(created.value, grant).journal, { kind: 'release', ...target });
    const denied = operate(released.journal, replaceClaim({ executor: executorA, valid_until: late }));
    expect(denied.result.code).toBe('ATTEMPT_LIMIT_REACHED');
    expect(denied.projection.claims).toEqual(released.projection.claims);
    expect(denied.projection.attempts).toEqual(released.projection.attempts);
  });

  it('creates a bound empty journal without changing the snapshot or request', async () => {
    const fixture = await executionFixture();
    const original = structuredClone(fixture);
    const result = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
    expect(result.ok && result.value.execution.entries).toEqual([]);
    expect(result.ok && result.value.execution.action_request).toEqual(fixture.request);
    expect(fixture).toEqual(original);
  });
});

describe('Execution Claim identity and serialization', () => {
  it.each(['claim', 'attempt'] as const)(
    'retains rejected grant %s identities instead of reassigning them',
    async (identity) => {
      const { journal } = await initialExecution();
      const first = operate(journal, grant);
      const proposed = { ...grant, claim_id: 'claim_b', attempt_id: 'attempt_b' };
      const rejected = operate(first.journal, proposed);
      expect(rejected.result.code).toBe('CLAIM_HELD');
      const duplicate = operate(rejected.journal, proposed);
      expect(duplicate.result).toEqual(rejected.result);
      const altered =
        identity === 'claim'
          ? { ...proposed, valid_until: '2026-09-10T10:07:00.000Z' }
          : { ...proposed, claim_id: 'claim_c' };
      const conflicted = operate(duplicate.journal, altered);
      expect(conflicted.result.code).toBe('IDENTITY_CONFLICT');
      expect(conflicted.projection.conflicts[0]?.namespace).toBe(identity);
      expect(conflicted.projection.claims).toEqual(first.projection.claims);
      expect(conflicted.projection.attempts).toEqual(first.projection.attempts);
    },
  );

  it('grants one pending Attempt and replays a lost grant acknowledgment without another append', async () => {
    const { journal } = await initialExecution();
    const first = operate(journal, grant);
    expect(first.result.code).toBe('CLAIM_ACQUIRED');
    expect(first.projection.claims).toHaveLength(1);
    expect(first.projection.attempts[0]?.status).toBe('pending');
    const duplicate = applyExecutionOperation(first.journal, first.context, first.operation);
    expect(duplicate).toMatchObject({
      ok: true,
      value: { replayed: true, journal: first.journal, result: first.result },
    });
    expect(replayExecutionJournal(first.journal)).toEqual({ ok: true, value: first.projection });
  });

  it.each(['a', 'b'] as const)('rejects stale competing proposals when executor %s acquires first', async (winner) => {
    const { journal, context } = await initialExecution();
    const grantB = { ...grant, executor: executorB, claim_id: 'claim_b', attempt_id: 'attempt_b' };
    const competing = winner === 'a' ? grantB : grant;
    const actor = { kind: 'executor' as const, executor: competing.executor };
    const winning = winner === 'a' ? grant : grantB;
    const operation = operationFor(journal, actor, competing, 'competitor');
    const first = operate(journal, winning, { kind: 'executor', executor: winning.executor });
    const result = applyExecutionOperation(first.journal, { ...context, actor }, operation);
    expect(result.ok && result.value.result.code).toBe('EXECUTION_VERSION_CONFLICT');
    if (!result.ok) return;
    const retry = operate(result.value.journal, competing, actor);
    expect(retry.result).toEqual(result.value.result);
    const fresh = operate(retry.journal, { ...competing, claim_id: 'fresh_claim', attempt_id: 'fresh_attempt' }, actor);
    expect(fresh.result.code).toBe('CLAIM_HELD');
    const changed = operate(retry.journal, { ...competing, valid_until: '2026-09-10T10:07:00.000Z' }, actor);
    expect(changed.result.code).toBe('IDENTITY_CONFLICT');
    expect(retry.projection.claims).toEqual(first.projection.claims);
    expect(retry.projection.attempts).toEqual(first.projection.attempts);
  });

  it('retains changed content under an operation identity as one replayable conflict', async () => {
    const { journal } = await initialExecution();
    const first = operate(journal, grant);
    const changed = { ...first.operation, command: { ...grant, valid_until: '2026-09-10T10:07:00.000Z' } };
    const result = applyExecutionOperation(first.journal, first.context, changed);
    expect(result.ok && result.value.result.code).toBe('IDENTITY_CONFLICT');
    if (!result.ok) return;
    expect(result.value.projection.conflicts).toHaveLength(1);
    expect(result.value.projection.claims).toEqual(first.projection.claims);
    expect(result.value.journal.execution.entries.at(-1)?.operation).toEqual(changed);
    const duplicate = applyExecutionOperation(result.value.journal, first.context, changed);
    expect(duplicate).toMatchObject({ ok: true, value: { replayed: true, journal: result.value.journal } });
  });

  it('rejects resealed journal tampering that violates actor binding even when every entry is admitted', async () => {
    const { journal } = await initialExecution();
    const tampered = structuredClone(operate(journal, grant).journal);
    tampered.execution.entries[0]!.context.actor = executorBActor;
    tampered.execution_digest = digest(tampered.execution);
    expect(codes(replayWith(tampered, { isAdmitted: () => true }))).toEqual(['ACTOR_MISMATCH']);
  });
});

describe('Attempt lifecycle and time', () => {
  it('starts once, expires inclusively, and cannot revive a running Attempt with a late renewal', async () => {
    const { journal } = await initialExecution();
    const started = startAttempt(journal);
    expect(operate(started.journal, { kind: 'start', ...target }).result.code).toBe('ATTEMPT_ALREADY_STARTED');
    const renewal = operate(
      started.journal,
      { kind: 'renew', ...target, valid_until: '2026-09-10T10:08:00.000Z' },
      undefined,
      late,
    );
    expect(renewal.result.code).toBe('CLAIM_FENCED');
    const expired = expireClaim(renewal.journal);
    expect(expired.result.code).toBe('CLAIM_EXPIRED');
    expect(expired.projection.attempts[0]).toMatchObject({ status: 'unknown_outcome', effect: 'unknown' });
    expect(operate(expired.journal, replaceClaim(), executorBActor, late).result.code).toBe('RECONCILIATION_REQUIRED');
  });

  it('requires a human decision and independent stopped/effect observations after a lost receipt', async () => {
    const { journal } = await initialExecution();
    const expired = expireClaim(startAttempt(journal).journal);
    const evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'effect_occurred')];
    const command = reconcileCommand('effect_confirmed', evidence, 'Publication independently observed');
    const forbidden = operate(expired.journal, command, controllerActor(journal), later, evidence);
    expect(forbidden.result.code).toBe('HUMAN_AUTHORITY_REQUIRED');
    const resolved = operate(forbidden.journal, command, humanActor(journal), later, [evidence[0]!, ...evidence]);
    expect(resolved.result.code).toBe('ATTEMPT_RECONCILED');
    expect(resolved.projection.request_status).toBe('satisfied');
    expect(resolved.projection.attempts[0]).toMatchObject({
      status: 'unknown_outcome',
      resolution: { disposition: 'effect_confirmed' },
    });
    expect(resolved.projection.receipts).toEqual([]);
  });
});

describe('Controller projection and preserved bindings', () => {
  it.each(['cancel', 'invalidate', 'expire'] as const)(
    'records %s against the original binding after the admitted run and graph move',
    async (kind) => {
      const { journal } = await initialExecution();
      const started = startAttempt(journal);
      const moved = await executionFixture('release-to-publish');
      moved.context.snapshot.binding.workflow_run_id = 'replacement_run';
      moved.context.snapshot.receipts = [];
      moved.context.snapshot.evaluation_time = late;
      const command: ExecutionOperation['command'] =
        kind === 'cancel'
          ? { kind, reason: 'Lifecycle moved' }
          : kind === 'invalidate'
            ? { kind, reason: 'binding_changed' }
            : { kind, ...target };
      const operation = operationFor(started.journal, moved.context.actor, command);
      const closed = applyExecutionOperation(started.journal, moved.context, operation);
      expect(closed.ok && closed.value.result.disposition, JSON.stringify(closed)).toBe('applied');
      if (!closed.ok) return;
      expect(closed.value.projection.attempts[0]).toMatchObject({ status: 'unknown_outcome', effect: 'unknown' });
      expect(closed.value.projection.claims[0]?.binding).toEqual(journal.execution.action_request.request.binding);
      expect(closed.value.projection.attempts[0]?.binding).toEqual(journal.execution.action_request.request.binding);
      const retargeted = applyExecutionOperation(started.journal, moved.context, {
        ...operation,
        binding: moved.context.snapshot.binding,
      });
      expect(retargeted.ok && retargeted.value.result.code).toBe('OPERATION_BINDING_MISMATCH');
      moved.context.actor = humanActor(journal);
      moved.context.snapshot.evaluation_time = later;
      moved.context.recovery_evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'no_effect')];
      const reconcile = reconcileCommand('no_effect_confirmed', moved.context.recovery_evidence);
      const recovered = applyExecutionOperation(
        closed.value.journal,
        moved.context,
        operationFor(closed.value.journal, moved.context.actor, reconcile),
      );
      expect(recovered.ok && recovered.value.result.code).toBe('ATTEMPT_RECONCILED');
      const executorContext = { ...moved.context, actor: { kind: 'executor' as const, executor: executorA } };
      const renew = { kind: 'renew' as const, ...target, valid_until: '2026-09-10T10:10:00.000Z' };
      const renewal = applyExecutionOperation(
        started.journal,
        executorContext,
        operationFor(started.journal, executorContext.actor, renew),
      );
      expect(codes(renewal)).toEqual(['CONTEXT_BINDING_MISMATCH']);
      const forbiddenClosure = applyExecutionOperation(
        started.journal,
        executorContext,
        operationFor(started.journal, executorContext.actor, command),
      );
      expect(forbiddenClosure.ok && forbiddenClosure.value.result.code).toBe('AUTHORITY_MISMATCH');
    },
  );

  it('does not use an absent start as no-effect proof when independent evidence reports an effect', async () => {
    const { journal } = await initialExecution();
    const expired = expireClaim(operate(journal, grant).journal);
    const result = operate(expired.journal, replaceClaim({ executor: executorA }), undefined, later, [
      recoveryFor(journal, 'effect_occurred'),
    ]);
    expect(result.result.code).toBe('RECONCILIATION_REQUIRED');
    expect(result.projection.attempts).toEqual(expired.projection.attempts);
  });

  it.each(['unclaimed', 'released', 'completed'] as const)(
    'keeps an inactive %s execution blocked when its exact request is no longer current',
    async (phase) => {
      const initial = await initialExecution();
      let journal = initial.journal;
      if (phase === 'released')
        journal = operate(operate(journal, grant).journal, { kind: 'release', ...target }).journal;
      if (phase === 'completed') journal = submitReceipt(startAttempt(journal).journal, receiptFor(journal)).journal;
      const before = replayExecutionJournal(journal);
      for (const drift of ['state', 'subject', 'policy', 'capability', 'observation'] as const) {
        const snapshot = structuredClone(initial.context.snapshot);
        snapshot.evaluation_time = '2026-09-10T10:01:00.000Z';
        if (drift === 'state') {
          snapshot.binding.state_version++;
          snapshot.observation.state_version++;
        } else if (drift === 'subject') {
          snapshot.binding.subject.content_digest = digest('new subject');
          snapshot.observation.subject = snapshot.binding.subject;
        } else if (drift === 'policy') snapshot.policy.id = 'new policy';
        else if (drift === 'capability') snapshot.available_capabilities = [];
        else snapshot.observation.valid_until = snapshot.evaluation_time;
        const projected = projectControllerExecution(journal, snapshot);
        expect(projected.ok && projected.value.execution.status, drift).toBe('reconciliation_required');
      }
      // Projection does not retract previously accepted receipts or mutate retained history.
      expect(replayExecutionJournal(journal)).toEqual(before);
    },
  );

  it.each(['current', 'retained'] as const)(
    'rejects no-effect reconciliation that omits %s contrary evidence',
    async (location) => {
      const { journal } = await initialExecution();
      let expired = expireClaim(startAttempt(journal).journal);
      const contrary = recoveryFor(journal, 'effect_occurred');
      if (location === 'retained') expired = expireClaim(expired.journal, later, [contrary]);
      const evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'no_effect')];
      const refused = operate(
        expired.journal,
        reconcileCommand('no_effect_confirmed', evidence, 'Selected only favorable observations'),
        humanActor(journal),
        later,
        location === 'current' ? [...evidence, contrary] : evidence,
      );
      expect(refused.result.code).toBe('RECOVERY_EVIDENCE_CONTRADICTORY');
      expect(refused.projection.attempts).toEqual(expired.projection.attempts);
      expect(refused.projection.request_status).toBe('open');
      const retry = operate(refused.journal, replaceClaim({ executor: executorA }), undefined, later);
      expect(retry.result.code).toBe('RECOVERY_EVIDENCE_CONTRADICTORY');
      expect(retry.projection.claims).toHaveLength(1);
    },
  );

  it('rejects expiry from an authority revoked by the current admitted policy', async () => {
    const { journal } = await initialExecution();
    const claimed = operate(journal, grant);
    const context = structuredClone(claimed.context);
    context.actor = controllerActor(journal);
    context.snapshot.evaluation_time = late;
    context.snapshot.policy.rules.authorities = context.snapshot.policy.rules.authorities.map((authority) =>
      authority.type === 'threadloop'
        ? { ...authority, identity: { id: 'new_controller', digest: digest('new controller') } }
        : authority,
    );
    context.snapshot.policy.digest = digest(context.snapshot.policy.rules);
    const expire = operationFor(claimed.journal, context.actor, { kind: 'expire', ...target });
    const result = applyExecutionOperation(claimed.journal, context, expire);
    expect(result.ok && result.value.result.code).toBe('AUTHORITY_MISMATCH');
    expect(result.ok && result.value.projection.claims).toEqual(claimed.projection.claims);
  });

  it('feeds healthy waiting and inclusive expiry into the real #105 candidate validator', async () => {
    const { journal, context } = await initialExecution();
    const claimed = operate(journal, grant);
    const projection = projectControllerExecution(claimed.journal, context.snapshot);
    if (!projection.ok) throw new Error(JSON.stringify(projection));
    const snapshot = { ...context.snapshot, ...projection.value };
    const decision: ControllerDecision['decision'] = {
      schema_version: '0.1',
      input_digest: digest(snapshot),
      binding: snapshot.binding,
      outcome: 'waiting',
      request: claimed.operation.request,
      claim: target.claim,
      attempt_id: target.attempt_id,
    };
    expect(validateControllerDecision(snapshot, { decision, decision_digest: digest(decision) }).ok).toBe(true);
    const lateSnapshot = { ...context.snapshot, evaluation_time: late };
    const expired = projectControllerExecution(claimed.journal, lateSnapshot);
    expect(expired.ok && expired.value.execution.status).toBe('reconciliation_required');
    if (!expired.ok) return;
    const blockedInput = { ...lateSnapshot, ...expired.value };
    const blocked: ControllerDecision['decision'] = {
      schema_version: '0.1',
      input_digest: digest(blockedInput),
      binding: snapshot.binding,
      outcome: 'blocked',
      reasons: [
        { code: 'EXECUTION_RECONCILIATION_REQUIRED', message: 'Claim expired', recovery: 'Reconcile the Attempt' },
      ],
    };
    const candidate = { decision: blocked, decision_digest: digest(blocked) };
    expect(validateControllerDecision(blockedInput, candidate).ok).toBe(true);
  });

  it.each([
    ['state', 'REQUEST_NOT_CURRENT'],
    ['subject', 'REQUEST_NOT_CURRENT'],
    ['policy', 'REQUEST_NOT_CURRENT'],
    ['fence', 'CLAIM_FENCED'],
  ] as const)('refuses renewal and evidence after %s drift', async (kind, code) => {
    const { journal } = await initialExecution();
    const started = startAttempt(journal);
    const context = structuredClone(started.context);
    context.snapshot.evaluation_time = '2026-09-10T10:01:00.000Z';
    if (kind === 'state') {
      context.snapshot.binding.state_version++;
      context.snapshot.observation.state_version++;
    }
    if (kind === 'subject') {
      context.snapshot.binding.subject.content_digest = digest('other');
      context.snapshot.observation.subject = context.snapshot.binding.subject;
    }
    if (kind === 'policy') context.snapshot.policy.id = 'other_policy';
    if (kind === 'fence') context.snapshot.invalidated_claims = [target.claim];
    const submit = { kind: 'submit_receipt' as const, receipt: receiptFor(journal) };
    const result = applyExecutionOperation(
      started.journal,
      context,
      operationFor(started.journal, context.actor, submit),
    );
    expect(result.ok && result.value.result.code).toBe(code);
    expect(result.ok && result.value.projection.attempts).toEqual(started.projection.attempts);
    const projected = projectControllerExecution(started.journal, context.snapshot);
    expect(projected.ok && projected.value.execution.status).toBe('reconciliation_required');
    const renew = { kind: 'renew' as const, ...target, valid_until: '2026-09-10T10:08:00.000Z' };
    const renewal = applyExecutionOperation(
      started.journal,
      context,
      operationFor(started.journal, context.actor, renew),
    );
    expect(renewal.ok && renewal.value.result.code).toBe(code === 'CLAIM_FENCED' ? code : 'REQUEST_NOT_CURRENT');
    const closure = structuredClone(context);
    closure.actor = controllerActor(journal);
    closure.snapshot.evaluation_time = late;
    const expire = operationFor(started.journal, closure.actor, { kind: 'expire', ...target });
    const expired = applyExecutionOperation(started.journal, closure, expire);
    expect(expired.ok && expired.value.result.code).toBe('CLAIM_EXPIRED');
    expect(expired.ok && expired.value.projection.claims[0]?.binding).toEqual(
      journal.execution.action_request.request.binding,
    );
  });
});

describe('Published execution contract corpus', () => {
  const bundle = new URL('../../docs/contracts/execution-v0.1/', import.meta.url);
  const stepName = z.enum([
    'acquire',
    'repeat_acquire',
    'compete',
    'start',
    'renew',
    'expire',
    'replace',
    'replace_with_stop',
    'receipt',
    'unadmitted_receipt',
    'repeat_receipt',
    'late_receipt',
    'receipt_collision',
    'reconcile_effect',
    'reconcile_no_effect',
    'cancel',
    'release',
    'invalidate',
  ]);

  it('publishes its schemas and checks independently specified lifecycle sequences against reconstructed history', async () => {
    const validators = await publishedValidators('execution', publishedExecutionSchemas());
    const scenarios = z
      .array(
        z.strictObject({
          id: z.string(),
          profile: z.enum(['governed-pr', 'release-to-publish']),
          retry_safety: z.enum(['reconciliation_required', 'repeatable_after_stop', 'repeatable_with_overlap']),
          steps: z.array(stepName),
          codes: z.array(z.string()),
          claims: z.array(z.string()),
          attempts: z.array(z.string()),
          request_status: z.string(),
          receipt_count: z.number().int(),
          projection: z.string(),
        }),
      )
      .parse(JSON.parse(await readFile(new URL('fixtures/scenarios.json', bundle), 'utf8')));
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(scenarios.length);
    for (const scenario of scenarios) {
      const initial = await initialExecution(scenario.retry_safety, scenario.profile);
      let journal = initial.journal;
      const results: string[] = [];
      let time = '2026-09-10T10:00:00.000Z';
      for (const name of scenario.steps) {
        let actor: ExecutionContext['actor'] = { kind: 'executor', executor: executorA };
        let command: ExecutionOperation['command'];
        let evidence: RecoveryEvidence[] = [];
        switch (name) {
          case 'acquire':
          case 'repeat_acquire':
            command = grant;
            break;
          case 'compete':
            command = { ...grant, executor: executorB, claim_id: 'claim_b', attempt_id: 'attempt_b' };
            actor = executorBActor;
            break;
          case 'start':
            command = { kind: 'start', ...target };
            break;
          case 'renew':
            command = { kind: 'renew', ...target, valid_until: '2026-09-10T10:08:00.000Z' };
            break;
          case 'expire':
            command = { kind: 'expire', ...target };
            actor = controllerActor(journal);
            time = late;
            break;
          case 'replace':
            command = replaceClaim();
            actor = executorBActor;
            break;
          case 'replace_with_stop':
            evidence = [recoveryFor(journal, 'executor_stopped')];
            time = later;
            command = replaceClaim({
              claim_id: 'claim_c',
              attempt_id: 'attempt_c',
              evidence_ids: ['executor_stopped'],
            });
            actor = executorBActor;
            break;
          case 'receipt':
          case 'unadmitted_receipt':
          case 'repeat_receipt':
          case 'receipt_collision':
          case 'late_receipt':
            time = name === 'late_receipt' ? later : '2026-09-10T10:01:00.000Z';
            command = {
              kind: 'submit_receipt',
              receipt: receiptFor(journal, name === 'receipt_collision' ? { status: 'failed' } : {}),
            };
            break;
          case 'reconcile_effect':
          case 'reconcile_no_effect': {
            const effect = name === 'reconcile_effect';
            evidence = [
              recoveryFor(journal, 'executor_stopped'),
              recoveryFor(journal, effect ? 'effect_occurred' : 'no_effect'),
            ];
            time = later;
            actor = humanActor(journal);
            command = reconcileCommand(effect ? 'effect_confirmed' : 'no_effect_confirmed', evidence);
            break;
          }
          case 'cancel':
            command = { kind: 'cancel', reason: 'Work withdrawn' };
            actor = controllerActor(journal);
            break;
          case 'release':
            command = { kind: 'release', ...target };
            break;
          case 'invalidate':
            command = { kind: 'invalidate', reason: 'authority_revoked' };
            actor = controllerActor(journal);
            break;
        }
        const result = operate(journal, command, actor, time, evidence, name === 'unadmitted_receipt' ? [] : undefined);
        results.push(result.result.code);
        journal = result.journal;
      }
      expect(results, scenario.id).toEqual(scenario.codes);
      expect(validators['execution-journal']!(journal), scenario.id + ': journal schema').toBe(true);
      const replayed = replayExecutionJournal(journal);
      if (!replayed.ok) throw new Error(scenario.id + JSON.stringify(replayed));
      const state = replayed.value;
      expect(
        state.claims.map((claim) => claim.status),
        scenario.id,
      ).toEqual(scenario.claims);
      expect(
        state.attempts.map((attempt) => attempt.status),
        scenario.id,
      ).toEqual(scenario.attempts);
      expect(state.request_status, scenario.id).toBe(scenario.request_status);
      expect(state.receipts.length, scenario.id).toBe(scenario.receipt_count);
      for (const claim of state.claims) expect(validators['execution-claim']!(claim), scenario.id).toBe(true);
      for (const attempt of state.attempts) expect(validators.attempt!(attempt), scenario.id).toBe(true);
      for (const receipt of state.receipts)
        expect(validators['attempt-receipt']!(receipt.envelope), scenario.id).toBe(true);
      const projected = projectControllerExecution(journal, { ...initial.context.snapshot, evaluation_time: time });
      expect(projected.ok && projected.value.execution.status, scenario.id).toBe(scenario.projection);
    }
  });

  it('rejects schema errors and semantically invalid resealed receipts with retained dispositions', async () => {
    const fixtures = z
      .array(
        z.strictObject({
          id: z.string(),
          path: z.array(z.string()),
          value: z.unknown(),
          reseal: z.boolean(),
          code: z.string(),
        }),
      )
      .parse(JSON.parse(await readFile(new URL('fixtures/rejections.json', bundle), 'utf8')));
    const { journal } = await initialExecution();
    const started = startAttempt(journal);
    for (const fixture of fixtures) {
      const context = structuredClone(started.context);
      context.snapshot.evaluation_time = '2026-09-10T10:01:00.000Z';
      const operation = operationFor(started.journal, context.actor, {
        kind: 'submit_receipt',
        receipt: receiptFor(journal),
      });
      let parent = operation as unknown as Record<string, unknown>;
      for (const part of fixture.path.slice(0, -1)) {
        if (['__proto__', 'prototype', 'constructor'].includes(part) || !(part in parent))
          throw new Error('Invalid fixture path');
        parent = parent[part] as Record<string, unknown>;
      }
      const key = fixture.path.at(-1)!;
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid fixture key');
      parent[key] = fixture.value;
      if (fixture.reseal && operation.command.kind === 'submit_receipt')
        operation.command.receipt.receipt_digest = digest(operation.command.receipt.receipt);
      const result = applyExecutionOperation(started.journal, context, operation);
      expect(result.ok ? [result.value.result.code] : codes(result), fixture.id).toContain(fixture.code);
      if (result.ok) {
        expect(result.value.projection.claims, fixture.id).toEqual(started.projection.claims);
        expect(result.value.projection.attempts, fixture.id).toEqual(started.projection.attempts);
        expect(result.value.journal.execution.entries.at(-1)?.operation, fixture.id).toEqual(operation);
      }
    }
  });

  it('matches independently authored claim and Attempt digest vectors', async () => {
    const expected = z
      .strictObject({ claim_digest: z.string(), attempt_digest: z.string() })
      .parse(JSON.parse(await readFile(new URL('fixtures/golden-digests.json', bundle), 'utf8')));
    const { journal } = await initialExecution();
    const claimed = operate(journal, grant);
    expect(digest(claimed.projection.claims[0])).toBe(expected.claim_digest);
    expect(digest(claimed.projection.attempts[0])).toBe(expected.attempt_digest);
  });
});

describe('Durable conflicts and bounded recovery', () => {
  it.each([false, true])(
    'records request identity observations despite stale operation preconditions (changed=%s)',
    async (changed) => {
      const { journal, context } = await initialExecution();
      const request = structuredClone(journal.execution.action_request);
      if (changed)
        request.request.inputs.push({ role: 'release_manifest', artifact: { id: 'other', digest: digest('other') } });
      request.request_digest = digest(request.request);
      const operation = operationFor(journal, context.actor, { kind: 'register_request', request }, 'registration');
      const acquired = operate(journal, grant);
      const result = applyExecutionOperation(acquired.journal, context, operation);
      expect(result.ok && result.value.result.code).toBe(changed ? 'IDENTITY_CONFLICT' : 'REQUEST_ALREADY_REGISTERED');
      if (!result.ok) return;
      expect(result.value.expected_execution_digest).toBe(acquired.journal.execution_digest);
      expect(result.value.projection.claims).toEqual(acquired.projection.claims);
      expect(result.value.projection.attempts).toEqual(acquired.projection.attempts);
      expect(result.value.journal.execution.action_request).toEqual(journal.execution.action_request);
      expect(replayExecutionJournal(result.value.journal)).toEqual({ ok: true, value: result.value.projection });
    },
  );

  it('retains observation identities from the initial context', async () => {
    const fixture = await initialExecution();
    const original = structuredClone(recoveryFor(fixture.journal, 'executor_stopped'));
    original.evidence.claim.id = 'earlier_claim';
    original.evidence.observed_at = '2026-09-10T09:59:00.000Z';
    original.evidence_digest = digest(original.evidence);
    fixture.context.recovery_evidence = [original];
    const created = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
    if (!created.ok) throw new Error(JSON.stringify(created));
    const journal = created.value;
    const expired = expireClaim(startAttempt(journal).journal);
    const evidence = [recoveryFor(journal, 'executor_stopped')];
    const result = operate(
      expired.journal,
      reconcileCommand('abandon', evidence, 'Stop verified'),
      humanActor(journal),
      later,
      evidence,
    );
    expect(result.result.code).toBe('IDENTITY_CONFLICT');
    expect(result.projection.conflicts[0]?.namespace).toBe('recovery_evidence');
    expect(result.projection.attempts).toEqual(expired.projection.attempts);
  });

  it.each(['governed-pr', 'release-to-publish'] as const)(
    'binds receipt and recovery results to the original %s subject identity',
    async (profile) => {
      const { journal } = await initialExecution('reconciliation_required', profile);
      const started = startAttempt(journal);
      const original = journal.execution.action_request.request.binding.subject;
      const foreign =
        original.kind === 'repository'
          ? { ...original, repository_id: 'foreign_repository' }
          : { ...original, artifact_id: 'foreign_artifact' };
      const changedKind =
        original.kind === 'repository'
          ? { kind: 'artifact' as const, artifact_id: 'foreign_artifact', content_digest: digest('foreign') }
          : {
              kind: 'repository' as const,
              repository_id: 'foreign_repository',
              revision: 'other',
              content_digest: digest('foreign'),
            };
      const successor = { ...original, content_digest: digest('changed content') };
      const expired = expireClaim(started.journal);
      for (const subject of [foreign, changedKind, successor]) {
        const valid = subject === successor;
        const receipt = receiptFor(journal, { effect: 'occurred', resulting_subject: subject });
        const reported = submitReceipt(started.journal, receipt);
        expect(reported.result.code).toBe(valid ? 'RECEIPT_ACCEPTED' : 'INVALID_ATTEMPT_OUTCOME');
        if (!valid) expect(reported.projection.attempts).toEqual(started.projection.attempts);
        const observation = structuredClone(recoveryFor(journal, 'effect_occurred'));
        observation.evidence.resulting_subject = subject;
        observation.evidence_digest = digest(observation.evidence);
        const evidence = [recoveryFor(journal, 'executor_stopped'), observation];
        const recovered = operate(
          expired.journal,
          reconcileCommand('effect_confirmed', evidence, 'Verify resulting subject'),
          humanActor(journal),
          later,
          evidence,
        );
        expect(recovered.result.code).toBe(valid ? 'ATTEMPT_RECONCILED' : 'RECOVERY_EVIDENCE_MISMATCH');
        expect(recovered.journal.execution.action_request.request.binding.subject).toEqual(original);
        if (!valid) expect(recovered.projection.attempts).toEqual(expired.projection.attempts);
      }
    },
  );

  it.each(['succeeded', 'failed'] as const)(
    'treats a %s no-effect receipt according to action outcome',
    async (status) => {
      const { journal } = await initialExecution();
      const subject = journal.execution.action_request.request.binding.subject;
      const reported = submitReceipt(startAttempt(journal).journal, receiptFor(journal, { status, effect: 'none' }));
      expect(reported.result.code).toBe('RECEIPT_ACCEPTED');
      expect(reported.projection.attempts[0]).toMatchObject({ binding: { subject }, resulting_subject: null });
      expect(reported.projection.receipts[0]?.envelope.receipt.binding.subject).toEqual(subject);
      const replacement = operate(
        reported.journal,
        replaceClaim({ executor: executorA, valid_until: late }),
        undefined,
        '2026-09-10T10:01:00.000Z',
      );
      expect(replacement.result.code).toBe(status === 'succeeded' ? 'REQUEST_CLOSED' : 'CLAIM_ACQUIRED');
      expect(replacement.projection.request_status).toBe(status === 'succeeded' ? 'satisfied' : 'open');
    },
  );

  it('retains changed recovery observations even when the reconciliation operation is replayed exactly', async () => {
    const { journal } = await initialExecution();
    const expired = expireClaim(startAttempt(journal).journal);
    const evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'no_effect')];
    const resolved = operate(
      expired.journal,
      reconcileCommand('no_effect_confirmed', evidence, 'Independently verified no effect'),
      humanActor(journal),
      later,
      evidence,
    );
    const changed = structuredClone(resolved.context);
    changed.recovery_evidence[1]!.evidence.kind = 'effect_occurred';
    changed.recovery_evidence[1]!.evidence_digest = digest(changed.recovery_evidence[1]!.evidence);
    const conflicted = applyExecutionOperation(resolved.journal, changed, resolved.operation);
    expect(conflicted.ok && conflicted.value.result.code).toBe('IDENTITY_CONFLICT');
    if (!conflicted.ok) return;
    expect(conflicted.value.projection.conflicts[0]?.namespace).toBe('recovery_evidence');
    expect(conflicted.value.projection.attempts).toEqual(resolved.projection.attempts);
    expect(replayExecutionJournal(conflicted.value.journal)).toEqual({ ok: true, value: conflicted.value.projection });
    const repeated = applyExecutionOperation(conflicted.value.journal, changed, resolved.operation);
    expect(repeated).toMatchObject({ ok: true, value: { replayed: true, journal: conflicted.value.journal } });
    const delivery = operationFor(conflicted.value.journal, changed.actor, resolved.operation.command, 'redelivery');
    const redelivered = applyExecutionOperation(conflicted.value.journal, changed, delivery);
    expect(redelivered).toMatchObject({ ok: true, value: { replayed: false, result: conflicted.value.result } });
    if (!redelivered.ok) return;
    expect(redelivered.value.projection.operations.at(-1)?.id).toBe(delivery.id);
    expect(replayExecutionJournal(redelivered.value.journal)).toEqual({
      ok: true,
      value: redelivered.value.projection,
    });
    const collision = applyExecutionOperation(redelivered.value.journal, changed, {
      ...delivery,
      command: { kind: 'cancel', reason: 'Changed intent' },
    });
    expect(collision.ok && collision.value.result.code).toBe('IDENTITY_CONFLICT');
    expect(collision.ok && collision.value.projection.conflicts.at(-1)?.namespace).toBe('operation');
  });

  it('keeps replaced execution uncertainty visible when its pending replacement is cancelled', async () => {
    const { journal, context } = await initialExecution('repeatable_with_overlap');
    const expired = expireClaim(startAttempt(journal).journal);
    const replaced = operate(expired.journal, replaceClaim(), executorBActor, late);
    const cancel = { kind: 'cancel' as const, reason: 'Stop all execution' };
    const cancelled = operate(replaced.journal, cancel, controllerActor(journal), later);
    const snapshot = { ...context.snapshot, evaluation_time: later };
    const status = (projected: ReturnType<typeof projectControllerExecution>) =>
      projected.ok ? projected.value.execution : null;
    expect(status(projectControllerExecution(replaced.journal, snapshot))?.status).toBe('in_flight');
    expect(replaced.projection.attempts[0]?.status).toBe('unknown_outcome');
    const invalidate = { kind: 'invalidate' as const, reason: 'integrity_failure' as const };
    const invalidated = operate(cancelled.journal, invalidate, controllerActor(journal), later);
    expect(status(projectControllerExecution(invalidated.journal, snapshot))).toMatchObject({
      status: 'reconciliation_required',
      attempt_id: 'attempt_a',
    });
    const stopped = [recoveryFor(journal, 'executor_stopped')];
    const abandoned = operate(
      replaced.journal,
      reconcileCommand('abandon', stopped, 'Abandon this request'),
      humanActor(journal),
      later,
      stopped,
    );
    expect(abandoned.projection.request_status).toBe('cancelled');
    expect(abandoned.projection.claims[1]?.status).toBe('cancelled');
    expect(abandoned.projection.attempts[1]?.status).toBe('cancelled');
    expect(abandoned.projection.attempts[0]).toMatchObject({
      status: 'unknown_outcome',
      effect: 'unknown',
      resolution: { disposition: 'abandon' },
    });
    expect(status(projectControllerExecution(abandoned.journal, snapshot))?.status).toBe('idle');
    const retry = {
      ...grant,
      claim_id: 'claim_after',
      attempt_id: 'attempt_after',
      valid_until: '2026-09-10T10:10:00.000Z',
    };
    const forbiddenRetry = operate(abandoned.journal, retry, undefined, later);
    expect(forbiddenRetry.result.code).toBe('REQUEST_CLOSED');
    expect(forbiddenRetry.projection.attempts).toHaveLength(2);
    expect(status(projectControllerExecution(cancelled.journal, snapshot))).toMatchObject({
      status: 'reconciliation_required',
      attempt_id: 'attempt_a',
    });
    const evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'no_effect')];
    const resolved = operate(
      cancelled.journal,
      reconcileCommand('no_effect_confirmed', evidence, 'Old executor stopped without effect'),
      humanActor(journal),
      later,
      evidence,
    );
    expect(resolved.result.code).toBe('ATTEMPT_RECONCILED');
    expect(status(projectControllerExecution(resolved.journal, snapshot))?.status).toBe('idle');
    expect(resolved.projection.request_status).toBe('cancelled');
  });

  it('records a valid changed Action Request under the existing logical identity as a durable conflict', async () => {
    const { journal } = await initialExecution();
    const proposal = structuredClone(journal.execution.action_request);
    proposal.request.inputs.push({ role: 'release_manifest', artifact: { id: 'another', digest: digest('input') } });
    proposal.request_digest = digest(proposal.request);
    const conflicted = operate(journal, { kind: 'register_request', request: proposal }, controllerActor(journal));
    expect(conflicted.result.code).toBe('IDENTITY_CONFLICT');
    expect(conflicted.projection.conflicts[0]?.namespace).toBe('request');
    const denied = operate(conflicted.journal, grant);
    expect(denied.result.code).toBe('UNRESOLVED_CONFLICT');
    const record = conflicted.projection.conflicts[0]!;
    const resolved = operate(
      denied.journal,
      { kind: 'resolve_conflict', conflict_id: record.id, original_digest: record.original_digest, reason: 'Keep' },
      humanActor(journal),
    );
    expect(resolved.result.code).toBe('CONFLICT_RESOLVED');
    expect(resolved.journal.execution.action_request).toEqual(journal.execution.action_request);
    expect(resolved.projection.conflicts[0]?.incoming_digest).toBe(proposal.request_digest);
    const next = operate(resolved.journal, { ...grant, claim_id: 'claim_after', attempt_id: 'attempt_after' });
    expect(next.result.code).toBe('CLAIM_ACQUIRED');
  });

  it('does not clear an unknown effect when the human resolves only an identity conflict', async () => {
    const { journal } = await initialExecution();
    const started = startAttempt(journal);
    const collided = operate(started.journal, { ...grant, valid_until: '2026-09-10T10:07:00.000Z' });
    expect(collided.result.code).toBe('IDENTITY_CONFLICT');
    const expired = expireClaim(collided.journal);
    const record = collided.projection.conflicts[0]!;
    const resolved = operate(
      expired.journal,
      { kind: 'resolve_conflict', conflict_id: record.id, original_digest: record.original_digest, reason: 'Keep' },
      humanActor(journal),
      late,
    );
    expect(resolved.projection.attempts[0]?.resolution).toBeNull();
    const projection = projectControllerExecution(resolved.journal, {
      ...started.context.snapshot,
      evaluation_time: late,
    });
    expect(projection.ok && projection.value.execution.status).toBe('reconciliation_required');
  });

  it.each([
    ['missing_stop', 'RECOVERY_EVIDENCE_INSUFFICIENT'],
    ['wrong_attempt', 'RECOVERY_EVIDENCE_MISMATCH'],
    ['wrong_subject', 'RECOVERY_EVIDENCE_MISMATCH'],
    ['bad_digest', 'RECOVERY_EVIDENCE_MISMATCH'],
    ['contradictory', 'RECOVERY_EVIDENCE_CONTRADICTORY'],
  ] as const)('rejects %s recovery evidence without altering the unknown Attempt', async (mode, code) => {
    const { journal } = await initialExecution('reconciliation_required', 'release-to-publish');
    const expired = expireClaim(startAttempt(journal).journal);
    const fact = structuredClone(recoveryFor(journal, 'no_effect'));
    if (mode === 'wrong_attempt') fact.evidence.attempt_id = 'other_attempt';
    if (mode === 'wrong_subject') fact.evidence.binding.subject.content_digest = digest('other');
    fact.evidence_digest = mode === 'bad_digest' ? digest('tampered') : digest(fact.evidence);
    const evidence = mode === 'missing_stop' ? [fact] : [fact, recoveryFor(journal, 'executor_stopped')];
    if (mode === 'contradictory') evidence.push(recoveryFor(journal, 'effect_occurred'));
    const result = operate(
      expired.journal,
      reconcileCommand('no_effect_confirmed', evidence, 'Request retry'),
      humanActor(journal),
      later,
      evidence,
    );
    expect(result.result.code).toBe(code);
    expect(result.projection.attempts).toEqual(expired.projection.attempts);
    expect(result.projection.request_status).toBe('open');
  });

  it('preserves accepted proof on normal closure but projects explicit integrity invalidation', async () => {
    const { journal } = await initialExecution();
    const accepted = submitReceipt(startAttempt(journal).journal, receiptFor(journal));
    const invalidated = operate(
      accepted.journal,
      { kind: 'invalidate', reason: 'integrity_failure' },
      controllerActor(journal),
      '2026-09-10T10:02:00.000Z',
    );
    expect(invalidated.result.code).toBe('REQUEST_INVALIDATED');
    expect(invalidated.projection.invalidated_claims).toEqual([target.claim]);
    expect(invalidated.projection.receipts).toEqual(accepted.projection.receipts);
  });

  it('caps renewal at immutable request validity and rejects time reversal without an append', async () => {
    const fixture = await executionFixture();
    fixture.request.request.constraints.valid_until = later;
    fixture.request.request_digest = digest(fixture.request.request);
    fixture.policy.rules.request.request_digest = fixture.request.request_digest;
    fixture.policy.digest = digest(fixture.policy.rules);
    const initial = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
    if (!initial.ok) throw new Error(JSON.stringify(initial));
    const claimed = operate(initial.value, grant);
    const renew = { kind: 'renew' as const, ...target, valid_until: '2026-09-10T10:07:00.000Z' };
    expect(operate(claimed.journal, renew).result.code).toBe('INVALID_CLAIM_DEADLINE');
    const context = {
      ...claimed.context,
      snapshot: { ...claimed.context.snapshot, evaluation_time: '2026-09-10T09:59:59.999Z' },
    };
    const start = operationFor(claimed.journal, context.actor, { kind: 'start', ...target });
    expect(codes(applyExecutionOperation(claimed.journal, context, start))).toEqual(['TIME_REVERSED']);
  });
});
