import { describe, expect, it } from 'vitest';
import { executionDigest } from '../../scripts/execution-contract/model.js';
import { validateControllerDecision } from '../../scripts/controller-contract/decision.js';
import type { ControllerDecision } from '../../scripts/controller-contract/contracts.js';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import {
  publishedExecutionSchemas,
  type ExecutionOperation,
  type ExecutionContext,
  type RecoveryEvidence,
  type ReceiptAdmission,
} from '../../scripts/execution-contract/contracts.js';
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
  grant,
  target,
  receiptFor,
  controllerActor,
  humanActor,
  recoveryFor,
  receiptAdmissionFor,
} from '../fixtures/execution-contract.js';

describe('Execution admission', () => {
  it('reserves a rejected report identity even when its submitter is not the bound executor', async () => {
    const { journal } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const receipt = receiptFor(journal);
    const rejected = operate(
      started.journal,
      { kind: 'submit_receipt', receipt },
      { kind: 'executor', executor: executorB },
      '2026-09-10T10:01:00.000Z',
      [],
      [],
    );
    expect(rejected.result.code).toBe('EXECUTOR_MISMATCH');
    expect(rejected.projection.receipts).toEqual([{ envelope: receipt, result: rejected.result }]);
    const exact = operate(rejected.journal, { kind: 'submit_receipt', receipt }, undefined, '2026-09-10T10:01:00.000Z');
    expect(exact.result).toEqual(rejected.result);
    const changed = operate(
      exact.journal,
      {
        kind: 'submit_receipt',
        receipt: receiptFor(journal, { status: 'failed' }),
      },
      undefined,
      '2026-09-10T10:01:00.000Z',
    );
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
        record.admission.acceptance.digest = executionDigest('different');
        record.admission_digest = executionDigest(record.admission);
      } else {
        const record = fixture.context.recovery_evidence[1]!;
        record.evidence.kind = 'effect_occurred';
        record.evidence_digest = executionDigest(record.evidence);
      }
      const created = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.diagnostics[0]?.code).toBe('INITIAL_EVIDENCE_CONFLICT');
      const tampered = structuredClone(fixture.journal);
      tampered.execution.initial_context = fixture.context;
      tampered.execution_digest = executionDigest(tampered.execution);
      expect(replayExecutionJournal(tampered).ok).toBe(false);
    },
  );

  it('retains every conflicting observation in a context before any observation is used', async () => {
    const { journal } = await initialExecution();
    const stop = recoveryFor(journal, 'executor_stopped');
    const changedStop = structuredClone(stop);
    changedStop.evidence.kind = 'effect_occurred';
    changedStop.evidence_digest = executionDigest(changedStop.evidence);
    const admission = receiptAdmissionFor(journal, receiptFor(journal));
    const changedAdmission = structuredClone(admission);
    changedAdmission.admission.acceptance.digest = executionDigest('different');
    changedAdmission.admission_digest = executionDigest(changedAdmission.admission);
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
      const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
      const expired = operate(
        started.journal,
        { kind: 'expire', ...target },
        controllerActor(journal),
        '2026-09-10T10:05:00.000Z',
      );
      const replacement = { claim: { id: 'claim_b', version: 2 }, attempt_id: 'attempt_b' };
      let current = operate(
        expired.journal,
        {
          kind: 'replace',
          previous_claim: target.claim,
          claim_id: 'claim_b',
          attempt_id: 'attempt_b',
          executor: executorB,
          valid_until: '2026-09-10T10:10:00.000Z',
          evidence_ids: [],
        },
        { kind: 'executor', executor: executorB },
        '2026-09-10T10:05:00.000Z',
      );
      if (phase !== 'pending')
        current = operate(
          current.journal,
          { kind: 'start', ...replacement },
          { kind: 'executor', executor: executorB },
          '2026-09-10T10:05:00.000Z',
        );
      if (phase === 'failed_no_effect')
        current = operate(
          current.journal,
          {
            kind: 'submit_receipt',
            receipt: receiptFor(journal, {
              ...replacement,
              executor: executorB,
              status: 'failed',
              finished_at: '2026-09-10T10:06:00.000Z',
            }),
          },
          { kind: 'executor', executor: executorB },
          '2026-09-10T10:06:00.000Z',
        );
      const evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'effect_occurred')];
      const confirmed = operate(
        current.journal,
        {
          kind: 'reconcile',
          ...target,
          disposition: 'effect_confirmed',
          evidence_ids: evidence.map((item) => item.evidence.id),
          reason: 'Earlier effect independently confirmed',
        },
        humanActor(journal),
        '2026-09-10T10:06:00.000Z',
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
      const projected = projectControllerExecution(confirmed.journal, {
        ...context.snapshot,
        evaluation_time: '2026-09-10T10:06:00.000Z',
      });
      expect(projected.ok && projected.value.execution.status).toBe(
        phase === 'running' ? 'reconciliation_required' : 'idle',
      );
      const retry = operate(
        confirmed.journal,
        {
          kind: 'replace',
          previous_claim: replacement.claim,
          claim_id: 'claim_c',
          attempt_id: 'attempt_c',
          executor: executorA,
          valid_until: '2026-09-10T10:10:00.000Z',
          evidence_ids: [],
        },
        undefined,
        '2026-09-10T10:06:00.000Z',
      );
      expect(retry.result.code).toBe('REQUEST_CLOSED');
    },
  );

  it.each(['succeeded', 'failed'] as const)('does not trust a raw %s no-effect report', async (status) => {
    const { journal } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const receipt = receiptFor(journal, {
      status,
      evidence: [{ id: 'invented', digest: executionDigest('invented') }],
    });
    const reported = operate(
      started.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T10:01:00.000Z',
      [],
      [],
    );
    expect(reported.result.code).toBe('RECEIPT_ADMISSION_MISMATCH');
    expect(reported.projection.request_status).toBe('open');
    expect(reported.projection.attempts[0]).toMatchObject({ status: 'running', effect: 'unknown', receipt_id: null });
    expect(reported.projection.receipts).toEqual([{ envelope: receipt, result: reported.result }]);
    const expired = operate(
      reported.journal,
      { kind: 'expire', ...target },
      controllerActor(journal),
      '2026-09-10T10:05:00.000Z',
    );
    const retry = operate(
      expired.journal,
      {
        kind: 'replace',
        previous_claim: target.claim,
        claim_id: 'claim_b',
        attempt_id: 'attempt_b',
        executor: executorB,
        valid_until: '2026-09-10T10:10:00.000Z',
        evidence_ids: [],
      },
      { kind: 'executor', executor: executorB },
      '2026-09-10T10:05:00.000Z',
    );
    expect(retry.result.code).toBe('RECONCILIATION_REQUIRED');
  });

  const admissionChanges: [string, (record: ReceiptAdmission) => void][] = [
    [
      'request',
      ({ admission }) => {
        admission.request.request_digest = executionDigest('other request');
      },
    ],
    [
      'run',
      ({ admission }) => {
        admission.binding.workflow_run_id = 'other_run';
      },
    ],
    [
      'graph',
      ({ admission }) => {
        admission.binding.graph_digest = executionDigest('other graph');
      },
    ],
    [
      'state',
      ({ admission }) => {
        admission.binding.state_version += 1;
      },
    ],
    [
      'subject',
      ({ admission }) => {
        admission.binding.subject.content_digest = executionDigest('other subject');
      },
    ],
    [
      'execution policy',
      ({ admission }) => {
        admission.execution_policy.digest = executionDigest('other policy');
      },
    ],
    [
      'claim',
      ({ admission }) => {
        admission.claim.id = 'other_claim';
      },
    ],
    [
      'generation',
      ({ admission }) => {
        admission.claim.version += 1;
      },
    ],
    [
      'Attempt',
      ({ admission }) => {
        admission.attempt_id = 'other_attempt';
      },
    ],
    [
      'executor',
      ({ admission }) => {
        admission.executor.incarnation = 'other_process';
      },
    ],
    [
      'receipt ID',
      ({ admission }) => {
        admission.receipt.id = 'other_receipt';
      },
    ],
    [
      'receipt digest',
      ({ admission }) => {
        admission.receipt.digest = executionDigest('other receipt');
      },
    ],
    [
      'verification policy',
      ({ admission }) => {
        admission.verification_policy.digest = executionDigest('other verifier');
      },
    ],
    [
      'before report',
      ({ admission }) => {
        admission.admitted_at = '2026-09-10T10:00:00.000Z';
      },
    ],
    [
      'future admission',
      ({ admission }) => {
        admission.admitted_at = '2026-09-10T10:02:00.000Z';
      },
    ],
    [
      'expiry boundary',
      ({ admission }) => {
        admission.valid_until = '2026-09-10T10:01:00.000Z';
      },
    ],
  ];
  it.each(admissionChanges)('rejects a resealed admission with mismatched %s', async (_name, change) => {
    const { journal } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const receipt = receiptFor(journal);
    const admission = receiptAdmissionFor(journal, receipt);
    change(admission);
    admission.admission_digest = executionDigest(admission.admission);
    const rejected = operate(
      started.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T10:01:00.000Z',
      [],
      [admission],
    );
    expect(rejected.result.code).toBe('RECEIPT_ADMISSION_MISMATCH');
    expect(rejected.projection.attempts).toEqual(started.projection.attempts);
    expect(rejected.projection.request_status).toBe('open');
    expect(rejected.journal.execution.entries.at(-1)?.context.receipt_admissions).toEqual([admission]);
  });

  it('rejects bad admission hashes and retains the original rejection after later admission', async () => {
    const { journal } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const receipt = receiptFor(journal);
    const admission = receiptAdmissionFor(journal, receipt);
    admission.admission_digest = executionDigest('wrong hash');
    const rejected = operate(
      started.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T10:01:00.000Z',
      [],
      [admission],
    );
    expect(rejected.result.code).toBe('RECEIPT_ADMISSION_MISMATCH');
    const corrected = receiptAdmissionFor(journal, receipt);
    corrected.admission.id = 'new_admission';
    corrected.admission_digest = executionDigest(corrected.admission);
    const redelivered = operate(
      rejected.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T10:01:00.000Z',
      [],
      [corrected],
    );
    expect(redelivered.result).toEqual(rejected.result);
    expect(redelivered.projection.attempts).toEqual(started.projection.attempts);
    const freshReceipt = receiptFor(journal, { id: 'verified_report' });
    const accepted = operate(
      redelivered.journal,
      { kind: 'submit_receipt', receipt: freshReceipt },
      undefined,
      '2026-09-10T10:01:00.000Z',
    );
    expect(accepted.result.code).toBe('RECEIPT_ACCEPTED');
  });

  it('deduplicates admitted reports without manufacturing controller guard receipts', async () => {
    const { journal, context } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const receipt = receiptFor(journal);
    const admission = receiptAdmissionFor(journal, receipt);
    const accepted = operate(
      started.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T10:01:00.000Z',
      [],
      [admission, structuredClone(admission)],
    );
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
      const receipt = receiptFor(fixture.journal);
      const original = receiptAdmissionFor(fixture.journal, receipt);
      let journal = fixture.journal;
      if (location === 'initial') {
        fixture.context.receipt_admissions = [original];
        const created = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
        if (!created.ok) throw new Error(JSON.stringify(created));
        journal = created.value;
      }
      const acquired = operate(journal, grant, undefined, '2026-09-10T10:00:00.000Z', [], [original]);
      const changed = structuredClone(acquired.context);
      changed.receipt_admissions[0]!.admission.acceptance.digest = executionDigest('changed acceptance');
      changed.receipt_admissions[0]!.admission_digest = executionDigest(changed.receipt_admissions[0]!.admission);
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.code).toBe('CLAIM_FENCED');
    expect(result.value.projection.claims).toEqual([]);
    expect(result.value.projection.attempts).toEqual([]);
  });

  it('enforces the admitted attempt limit even when earlier work never started', async () => {
    const fixture = await executionFixture();
    fixture.policy.rules.max_attempts = 1;
    fixture.policy.digest = executionDigest(fixture.policy.rules);
    const created = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const released = operate(operate(created.value, grant).journal, { kind: 'release', ...target });
    const denied = operate(released.journal, {
      kind: 'replace',
      previous_claim: target.claim,
      claim_id: 'claim_b',
      attempt_id: 'attempt_b',
      executor: executorA,
      valid_until: '2026-09-10T10:05:00.000Z',
      evidence_ids: [],
    });
    expect(denied.result.code).toBe('ATTEMPT_LIMIT_REACHED');
    expect(denied.projection.claims).toEqual(released.projection.claims);
    expect(denied.projection.attempts).toEqual(released.projection.attempts);
  });

  it('creates a bound empty journal without changing the snapshot or request', async () => {
    const fixture = await executionFixture();
    const original = structuredClone(fixture);
    const result = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.execution.entries).toEqual([]);
      expect(result.value.execution.action_request).toEqual(fixture.request);
    }
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
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) {
      expect(duplicate.value.replayed).toBe(true);
      expect(duplicate.value.journal).toEqual(first.journal);
      expect(duplicate.value.result).toEqual(first.result);
    }
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.code).toBe('EXECUTION_VERSION_CONFLICT');
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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.code).toBe('IDENTITY_CONFLICT');
    expect(result.value.projection.conflicts).toHaveLength(1);
    expect(result.value.projection.claims).toEqual(first.projection.claims);
    expect(result.value.journal.execution.entries.at(-1)?.operation).toEqual(changed);
    const duplicate = applyExecutionOperation(result.value.journal, first.context, changed);
    expect(duplicate.ok && duplicate.value.replayed).toBe(true);
    if (duplicate.ok) expect(duplicate.value.journal).toEqual(result.value.journal);
  });

  it('rejects resealed journal tampering that violates actor and request binding', async () => {
    const { journal } = await initialExecution();
    const first = operate(journal, grant);
    const tampered = structuredClone(first.journal);
    tampered.execution.entries[0]!.context.actor = { kind: 'executor', executor: executorB };
    tampered.execution_digest = executionDigest(tampered.execution);
    expect(replayExecutionJournal(tampered).ok).toBe(false);
  });
});

describe('Attempt lifecycle and time', () => {
  it('starts once and renews without changing the claim generation or Attempt', async () => {
    const { journal } = await initialExecution();
    const claimed = operate(journal, grant);
    const started = operate(claimed.journal, { kind: 'start', ...target });
    expect(started.result.code).toBe('ATTEMPT_STARTED');
    const duplicateStart = operate(started.journal, { kind: 'start', ...target });
    expect(duplicateStart.result.code).toBe('ATTEMPT_ALREADY_STARTED');
    const renewed = operate(duplicateStart.journal, {
      kind: 'renew',
      ...target,
      valid_until: '2026-09-10T10:08:00.000Z',
    });
    expect(renewed.result.code).toBe('CLAIM_RENEWED');
    expect(renewed.projection.claims[0]?.version).toBe(1);
    expect(renewed.projection.attempts).toEqual(started.projection.attempts);
  });

  it('expires inclusively and cannot revive a running Attempt with a late renewal', async () => {
    const { journal } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const now = '2026-09-10T10:05:00.000Z';
    const renewal = operate(
      started.journal,
      { kind: 'renew', ...target, valid_until: '2026-09-10T10:08:00.000Z' },
      undefined,
      now,
    );
    expect(renewal.result.code).toBe('CLAIM_FENCED');
    const expired = operate(renewal.journal, { kind: 'expire', ...target }, controllerActor(journal), now);
    expect(expired.result.code).toBe('CLAIM_EXPIRED');
    expect(expired.projection.attempts[0]?.status).toBe('unknown_outcome');
    expect(expired.projection.attempts[0]?.effect).toBe('unknown');
    const replacement = operate(
      expired.journal,
      {
        kind: 'replace',
        previous_claim: target.claim,
        claim_id: 'claim_b',
        attempt_id: 'attempt_b',
        executor: executorB,
        valid_until: '2026-09-10T10:10:00.000Z',
        evidence_ids: [],
      },
      { kind: 'executor', executor: executorB },
      now,
    );
    expect(replacement.result.code).toBe('RECONCILIATION_REQUIRED');
  });

  it('can replace a claim whose executor died before admitted start, fencing its late evidence', async () => {
    const { journal } = await initialExecution();
    const claimed = operate(journal, grant);
    const expired = operate(
      claimed.journal,
      { kind: 'expire', ...target },
      controllerActor(journal),
      '2026-09-10T10:05:00.000Z',
    );
    const replaced = operate(
      expired.journal,
      {
        kind: 'replace',
        previous_claim: target.claim,
        claim_id: 'claim_b',
        attempt_id: 'attempt_b',
        executor: executorB,
        valid_until: '2026-09-10T10:10:00.000Z',
        evidence_ids: [],
      },
      { kind: 'executor', executor: executorB },
      '2026-09-10T10:05:00.000Z',
    );
    expect(replaced.result.code).toBe('CLAIM_ACQUIRED');
    expect(replaced.projection.claims.map((claim) => claim.version)).toEqual([1, 2]);
    const late = operate(
      replaced.journal,
      { kind: 'submit_receipt', receipt: receiptFor(journal) },
      undefined,
      '2026-09-10T10:06:00.000Z',
    );
    expect(late.result.code).toBe('CLAIM_FENCED');
    expect(late.projection.receipts).toHaveLength(1);
    expect(late.projection.attempts).toEqual(replaced.projection.attempts);
    expect(late.projection.claims).toEqual(replaced.projection.claims);
  });
});

describe('Terminal receipts and non-repeatable recovery', () => {
  it('accepts a current receipt once and replays it after claim closure and elapsed time', async () => {
    const { journal } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const receipt = receiptFor(journal);
    const accepted = operate(
      started.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T10:01:00.000Z',
    );
    expect(accepted.result.code).toBe('RECEIPT_ACCEPTED');
    expect(accepted.projection.request_status).toBe('satisfied');
    const repeated = operate(
      accepted.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T11:00:00.000Z',
    );
    expect(repeated.result).toEqual(accepted.result);
    expect(repeated.projection.receipts).toHaveLength(1);
    expect(repeated.projection.invalidated_claims).toEqual([]);
    const changedReceipt = receiptFor(journal, { status: 'failed' });
    const conflict = operate(
      repeated.journal,
      { kind: 'submit_receipt', receipt: changedReceipt },
      undefined,
      '2026-09-10T11:00:00.000Z',
    );
    expect(conflict.result.code).toBe('IDENTITY_CONFLICT');
    expect(conflict.projection.receipts).toEqual(accepted.projection.receipts);
  });

  it.each(['cancel', 'release', 'expire'] as const)(
    'does not interpret %s during execution as proof of no effect',
    async (kind) => {
      const { journal } = await initialExecution();
      const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
      const stopped = operate(
        started.journal,
        kind === 'cancel' ? { kind, reason: 'operator stop' } : { kind, ...target },
        kind === 'release' ? undefined : controllerActor(journal),
        kind === 'release' ? '2026-09-10T10:04:00.000Z' : '2026-09-10T10:05:00.000Z',
      );
      expect(stopped.result.disposition).toBe('applied');
      expect(stopped.projection.attempts[0]?.status).toBe('unknown_outcome');
      expect(stopped.projection.attempts[0]?.effect).toBe('unknown');
    },
  );

  it('requires a human decision and independent stopped/effect observations after a lost receipt', async () => {
    const { journal } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const expired = operate(
      started.journal,
      { kind: 'expire', ...target },
      controllerActor(journal),
      '2026-09-10T10:05:00.000Z',
    );
    const evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'effect_occurred')];
    const command = {
      kind: 'reconcile' as const,
      ...target,
      disposition: 'effect_confirmed' as const,
      evidence_ids: evidence.map((item) => item.evidence.id),
      reason: 'Publication independently observed',
    };
    const forbidden = operate(expired.journal, command, controllerActor(journal), '2026-09-10T10:06:00.000Z', evidence);
    expect(forbidden.result.code).toBe('HUMAN_AUTHORITY_REQUIRED');
    const resolved = operate(forbidden.journal, command, humanActor(journal), '2026-09-10T10:06:00.000Z', [
      evidence[0]!,
      ...evidence,
    ]);
    expect(resolved.result.code).toBe('ATTEMPT_RECONCILED');
    expect(resolved.projection.request_status).toBe('satisfied');
    expect(resolved.projection.attempts[0]?.status).toBe('unknown_outcome');
    expect(resolved.projection.attempts[0]?.resolution?.disposition).toBe('effect_confirmed');
    expect(resolved.projection.receipts).toEqual([]);
  });

  it('cancels before acquisition without granting an Attempt', async () => {
    const { journal } = await initialExecution();
    const cancelled = operate(journal, { kind: 'cancel', reason: 'Work withdrawn' }, controllerActor(journal));
    const refused = operate(cancelled.journal, grant);
    expect(refused.result.code).toBe('REQUEST_CLOSED');
    expect(refused.projection.attempts).toEqual([]);
  });
});

describe('Controller projection and preserved bindings', () => {
  it.each(['cancel', 'invalidate', 'expire'] as const)(
    'records %s against the original binding after the admitted run and graph move',
    async (kind) => {
      const { journal } = await initialExecution();
      const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
      const moved = await executionFixture('release-to-publish');
      moved.context.snapshot.binding.workflow_run_id = 'replacement_run';
      moved.context.snapshot.receipts = [];
      moved.context.snapshot.evaluation_time = '2026-09-10T10:05:00.000Z';
      const command: ExecutionOperation['command'] =
        kind === 'cancel'
          ? { kind, reason: 'Lifecycle moved' }
          : kind === 'invalidate'
            ? { kind, reason: 'binding_changed' }
            : { kind, ...target };
      const operation = operationFor(started.journal, moved.context.actor, command);
      const closed = applyExecutionOperation(started.journal, moved.context, operation);
      expect(closed.ok, JSON.stringify(closed)).toBe(true);
      if (!closed.ok) return;
      expect(closed.value.result.disposition).toBe('applied');
      expect(closed.value.projection.attempts[0]).toMatchObject({ status: 'unknown_outcome', effect: 'unknown' });
      expect(closed.value.projection.claims[0]?.binding).toEqual(journal.execution.action_request.request.binding);
      expect(closed.value.projection.attempts[0]?.binding).toEqual(journal.execution.action_request.request.binding);
      const retargeted = applyExecutionOperation(started.journal, moved.context, {
        ...operation,
        binding: moved.context.snapshot.binding,
      });
      expect(retargeted.ok && retargeted.value.result.code).toBe('OPERATION_BINDING_MISMATCH');
      moved.context.actor = humanActor(journal);
      moved.context.snapshot.evaluation_time = '2026-09-10T10:06:00.000Z';
      moved.context.recovery_evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'no_effect')];
      const recovered = applyExecutionOperation(
        closed.value.journal,
        moved.context,
        operationFor(closed.value.journal, moved.context.actor, {
          kind: 'reconcile',
          ...target,
          disposition: 'no_effect_confirmed',
          evidence_ids: moved.context.recovery_evidence.map((item) => item.evidence.id),
          reason: 'Reconcile the original Attempt',
        }),
      );
      expect(recovered.ok && recovered.value.result.code).toBe('ATTEMPT_RECONCILED');
      const executorContext = { ...moved.context, actor: { kind: 'executor' as const, executor: executorA } };
      const renewal = applyExecutionOperation(
        started.journal,
        executorContext,
        operationFor(started.journal, executorContext.actor, {
          kind: 'renew',
          ...target,
          valid_until: '2026-09-10T10:10:00.000Z',
        }),
      );
      expect(renewal).toMatchObject({ ok: false, diagnostics: [{ code: 'CONTEXT_BINDING_MISMATCH' }] });
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
    const expired = operate(
      operate(journal, grant).journal,
      { kind: 'expire', ...target },
      controllerActor(journal),
      '2026-09-10T10:05:00.000Z',
    );
    const result = operate(
      expired.journal,
      {
        ...grant,
        kind: 'replace',
        claim_id: 'claim_b',
        attempt_id: 'attempt_b',
        previous_claim: target.claim,
        valid_until: '2026-09-10T10:10:00.000Z',
        evidence_ids: [],
      },
      undefined,
      '2026-09-10T10:06:00.000Z',
      [recoveryFor(journal, 'effect_occurred')],
    );
    expect(result.result.code).toBe('RECONCILIATION_REQUIRED');
    expect(result.projection.attempts).toEqual(expired.projection.attempts);
  });

  it.each(['unclaimed', 'released', 'completed'] as const)(
    'keeps an inactive %s execution blocked when its exact request is no longer current',
    async (phase) => {
      const initial = await initialExecution();
      let journal = initial.journal;
      if (phase !== 'unclaimed') {
        journal = operate(journal, grant).journal;
        if (phase === 'released') journal = operate(journal, { kind: 'release', ...target }).journal;
        else {
          journal = operate(journal, { kind: 'start', ...target }).journal;
          journal = operate(
            journal,
            { kind: 'submit_receipt', receipt: receiptFor(journal) },
            undefined,
            '2026-09-10T10:01:00.000Z',
          ).journal;
        }
      }
      const before = replayExecutionJournal(journal);
      for (const drift of ['state', 'subject', 'policy', 'capability', 'observation'] as const) {
        const snapshot = structuredClone(initial.context.snapshot);
        snapshot.evaluation_time = '2026-09-10T10:01:00.000Z';
        if (drift === 'state') {
          snapshot.binding.state_version++;
          snapshot.observation.state_version++;
        } else if (drift === 'subject') {
          snapshot.binding.subject.content_digest = executionDigest('new subject');
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
      const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
      let expired = operate(
        started.journal,
        { kind: 'expire', ...target },
        controllerActor(journal),
        '2026-09-10T10:05:00.000Z',
      );
      const contrary = recoveryFor(journal, 'effect_occurred');
      if (location === 'retained')
        expired = operate(
          expired.journal,
          { kind: 'expire', ...target },
          controllerActor(journal),
          '2026-09-10T10:06:00.000Z',
          [contrary],
        );
      const evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'no_effect')];
      const refused = operate(
        expired.journal,
        {
          kind: 'reconcile',
          ...target,
          disposition: 'no_effect_confirmed',
          evidence_ids: evidence.map((item) => item.evidence.id),
          reason: 'Selected only favorable observations',
        },
        humanActor(journal),
        '2026-09-10T10:06:00.000Z',
        location === 'current' ? [...evidence, contrary] : evidence,
      );
      expect(refused.result.code).toBe('RECOVERY_EVIDENCE_CONTRADICTORY');
      expect(refused.projection.attempts).toEqual(expired.projection.attempts);
      expect(refused.projection.request_status).toBe('open');
      const retry = operate(
        refused.journal,
        {
          ...grant,
          kind: 'replace',
          claim_id: 'claim_b',
          attempt_id: 'attempt_b',
          previous_claim: target.claim,
          valid_until: '2026-09-10T10:10:00.000Z',
          evidence_ids: [],
        },
        undefined,
        '2026-09-10T10:06:00.000Z',
      );
      expect(retry.result.disposition).toBe('rejected');
      expect(retry.projection.claims).toHaveLength(1);
    },
  );

  it('rejects expiry from an authority revoked by the current admitted policy', async () => {
    const { journal } = await initialExecution();
    const claimed = operate(journal, grant);
    const context = structuredClone(claimed.context);
    context.actor = controllerActor(journal);
    context.snapshot.evaluation_time = '2026-09-10T10:05:00.000Z';
    context.snapshot.policy.rules.authorities = context.snapshot.policy.rules.authorities.map((authority) =>
      authority.type === 'threadloop'
        ? { ...authority, identity: { id: 'new_controller', digest: executionDigest('new controller') } }
        : authority,
    );
    context.snapshot.policy.digest = executionDigest(context.snapshot.policy.rules);
    const result = applyExecutionOperation(
      claimed.journal,
      context,
      operationFor(claimed.journal, context.actor, { kind: 'expire', ...target }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.code).toBe('AUTHORITY_MISMATCH');
    expect(result.value.projection.claims).toEqual(claimed.projection.claims);
  });
  it('feeds healthy waiting and inclusive expiry into the real #105 candidate validator', async () => {
    const { journal, context } = await initialExecution();
    const claimed = operate(journal, grant);
    const projection = projectControllerExecution(claimed.journal, context.snapshot);
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    const snapshot = { ...context.snapshot, ...projection.value };
    const decision: ControllerDecision['decision'] = {
      schema_version: '0.1',
      input_digest: executionDigest(snapshot),
      binding: snapshot.binding,
      outcome: 'waiting',
      request: claimed.operation.request,
      claim: target.claim,
      attempt_id: target.attempt_id,
    };
    expect(validateControllerDecision(snapshot, { decision, decision_digest: executionDigest(decision) }).ok).toBe(
      true,
    );
    const lateSnapshot = { ...context.snapshot, evaluation_time: '2026-09-10T10:05:00.000Z' };
    const expired = projectControllerExecution(claimed.journal, lateSnapshot);
    expect(expired.ok && expired.value.execution.status).toBe('reconciliation_required');
    if (!expired.ok) return;
    const blockedInput = { ...lateSnapshot, ...expired.value };
    const blocked: ControllerDecision['decision'] = {
      schema_version: '0.1',
      input_digest: executionDigest(blockedInput),
      binding: snapshot.binding,
      outcome: 'blocked',
      reasons: [
        {
          code: 'EXECUTION_RECONCILIATION_REQUIRED',
          message: 'Claim expired',
          recovery: 'Reconcile the retained Attempt',
        },
      ],
    };
    expect(
      validateControllerDecision(blockedInput, { decision: blocked, decision_digest: executionDigest(blocked) }).ok,
    ).toBe(true);
  });

  it.each(['state', 'subject', 'policy', 'fence'] as const)(
    'refuses renewal and evidence after %s drift',
    async (kind) => {
      const { journal } = await initialExecution();
      const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
      const context = structuredClone(started.context);
      context.snapshot.evaluation_time = '2026-09-10T10:01:00.000Z';
      if (kind === 'state') {
        context.snapshot.binding.state_version++;
        context.snapshot.observation.state_version++;
      }
      if (kind === 'subject') {
        context.snapshot.binding.subject.content_digest = executionDigest('other');
        context.snapshot.observation.subject = context.snapshot.binding.subject;
      }
      if (kind === 'policy') context.snapshot.policy.id = 'other_policy';
      if (kind === 'fence') context.snapshot.invalidated_claims = [target.claim];
      const operation = operationFor(
        started.journal,
        { kind: 'executor', executor: executorA },
        { kind: 'submit_receipt', receipt: receiptFor(journal) },
      );
      const result = applyExecutionOperation(started.journal, context, operation);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.result.disposition).toBe('rejected');
        expect(result.value.projection.attempts).toEqual(started.projection.attempts);
      }
      const projected = projectControllerExecution(started.journal, context.snapshot);
      expect(projected.ok && projected.value.execution.status).toBe('reconciliation_required');
      const renewal = applyExecutionOperation(
        started.journal,
        context,
        operationFor(started.journal, context.actor, {
          kind: 'renew',
          ...target,
          valid_until: '2026-09-10T10:08:00.000Z',
        }),
      );
      expect(renewal.ok && renewal.value.result.disposition).toBe('rejected');
      const closure = structuredClone(context);
      closure.actor = controllerActor(journal);
      closure.snapshot.evaluation_time = '2026-09-10T10:05:00.000Z';
      const expired = applyExecutionOperation(
        started.journal,
        closure,
        operationFor(started.journal, closure.actor, { kind: 'expire', ...target }),
      );
      expect(expired.ok && expired.value.result.code).toBe('CLAIM_EXPIRED');
      if (expired.ok)
        expect(expired.value.projection.claims[0]?.binding).toEqual(journal.execution.action_request.request.binding);
    },
  );
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

  it('publishes offline schemas matching the strict typed definitions', async () => {
    for (const [name, schema] of Object.entries(publishedExecutionSchemas())) {
      const saved = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(await readFile(new URL(`schemas/${name}.schema.json`, bundle), 'utf8')));
      expect(saved).toEqual(schema);
      expect(new Ajv2020({ strict: true, strictTypes: false, validateFormats: false }).validateSchema(saved)).toBe(
        true,
      );
    }
  });

  it('checks independently specified lifecycle sequences against schemas and reconstructed history', async () => {
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
    const schemas = publishedExecutionSchemas();
    const ajv = new Ajv2020({ strict: true, strictTypes: false, validateFormats: false });
    const checkJournal = ajv.compile(schemas['execution-journal']!);
    const checkClaim = ajv.compile(schemas['execution-claim']!);
    const checkAttempt = ajv.compile(schemas.attempt!);
    const checkReceipt = ajv.compile(schemas['attempt-receipt']!);
    for (const scenario of scenarios) {
      const initial = await initialExecution(scenario.retry_safety, scenario.profile);
      let journal = initial.journal;
      const codes: string[] = [];
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
            actor = { kind: 'executor', executor: executorB };
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
            time = '2026-09-10T10:05:00.000Z';
            break;
          case 'replace':
          case 'replace_with_stop':
            if (name === 'replace_with_stop') {
              evidence = [recoveryFor(journal, 'executor_stopped')];
              time = '2026-09-10T10:06:00.000Z';
            }
            command = {
              kind: 'replace',
              previous_claim: target.claim,
              claim_id: name === 'replace_with_stop' ? 'claim_c' : 'claim_b',
              attempt_id: name === 'replace_with_stop' ? 'attempt_c' : 'attempt_b',
              executor: executorB,
              valid_until: '2026-09-10T10:10:00.000Z',
              evidence_ids: evidence.map((item) => item.evidence.id),
            };
            actor = { kind: 'executor', executor: executorB };
            break;
          case 'receipt':
          case 'unadmitted_receipt':
          case 'repeat_receipt':
          case 'receipt_collision':
          case 'late_receipt':
            time = name === 'late_receipt' ? '2026-09-10T10:06:00.000Z' : '2026-09-10T10:01:00.000Z';
            command = {
              kind: 'submit_receipt',
              receipt: receiptFor(journal, name === 'receipt_collision' ? { status: 'failed' } : {}),
            };
            break;
          case 'reconcile_effect':
          case 'reconcile_no_effect':
            evidence = [
              recoveryFor(journal, 'executor_stopped'),
              recoveryFor(journal, name === 'reconcile_effect' ? 'effect_occurred' : 'no_effect'),
            ];
            time = '2026-09-10T10:06:00.000Z';
            actor = humanActor(journal);
            command = {
              kind: 'reconcile',
              ...target,
              disposition: name === 'reconcile_effect' ? 'effect_confirmed' : 'no_effect_confirmed',
              evidence_ids: evidence.map((item) => item.evidence.id),
              reason: 'Independent observation checked by the operator',
            };
            break;
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
        codes.push(result.result.code);
        journal = result.journal;
      }
      expect(codes, scenario.id).toEqual(scenario.codes);
      expect(checkJournal(journal), scenario.id + ': journal schema').toBe(true);
      const replayed = replayExecutionJournal(journal);
      expect(replayed.ok, scenario.id).toBe(true);
      if (!replayed.ok) continue;
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
      for (const claim of state.claims) expect(checkClaim(claim), scenario.id).toBe(true);
      for (const attempt of state.attempts) expect(checkAttempt(attempt), scenario.id).toBe(true);
      for (const receipt of state.receipts) expect(checkReceipt(receipt.envelope), scenario.id).toBe(true);
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
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
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
        operation.command.receipt.receipt_digest = executionDigest(operation.command.receipt.receipt);
      const result = applyExecutionOperation(started.journal, context, operation);
      const codes = result.ok ? [result.value.result.code] : result.diagnostics.map((diagnostic) => diagnostic.code);
      expect(codes, fixture.id).toContain(fixture.code);
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
    expect(executionDigest(claimed.projection.claims[0])).toBe(expected.claim_digest);
    expect(executionDigest(claimed.projection.attempts[0])).toBe(expected.attempt_digest);
  });
});

describe('Durable conflicts and bounded recovery', () => {
  it.each([false, true])(
    'records request identity observations despite stale operation preconditions (changed=%s)',
    async (changed) => {
      const { journal, context } = await initialExecution();
      const request = structuredClone(journal.execution.action_request);
      if (changed)
        request.request.inputs.push({
          role: 'release_manifest',
          artifact: { id: 'other_input', digest: executionDigest('other input') },
        });
      request.request_digest = executionDigest(request.request);
      const operation = operationFor(journal, context.actor, { kind: 'register_request', request }, 'registration');
      const acquired = operate(journal, grant);
      const result = applyExecutionOperation(acquired.journal, context, operation);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.result.code).toBe(changed ? 'IDENTITY_CONFLICT' : 'REQUEST_ALREADY_REGISTERED');
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
    original.evidence_digest = executionDigest(original.evidence);
    fixture.context.recovery_evidence = [original];
    const created = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const journal = created.value;
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const expired = operate(
      started.journal,
      { kind: 'expire', ...target },
      controllerActor(journal),
      '2026-09-10T10:05:00.000Z',
    );
    const evidence = [recoveryFor(journal, 'executor_stopped')];
    const result = operate(
      expired.journal,
      {
        kind: 'reconcile',
        ...target,
        disposition: 'abandon',
        evidence_ids: ['executor_stopped'],
        reason: 'Stop verified',
      },
      humanActor(journal),
      '2026-09-10T10:06:00.000Z',
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
      const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
      const original = journal.execution.action_request.request.binding.subject;
      const foreign =
        original.kind === 'repository'
          ? { ...original, repository_id: 'foreign_repository' }
          : { ...original, artifact_id: 'foreign_artifact' };
      const changedKind =
        original.kind === 'repository'
          ? { kind: 'artifact' as const, artifact_id: 'foreign_artifact', content_digest: executionDigest('foreign') }
          : {
              kind: 'repository' as const,
              repository_id: 'foreign_repository',
              revision: 'other',
              content_digest: executionDigest('foreign'),
            };
      const successor = { ...original, content_digest: executionDigest('changed content') };
      const expired = operate(
        started.journal,
        { kind: 'expire', ...target },
        controllerActor(journal),
        '2026-09-10T10:05:00.000Z',
      );
      for (const subject of [foreign, changedKind, successor]) {
        const valid = subject === successor;
        const reported = operate(
          started.journal,
          {
            kind: 'submit_receipt',
            receipt: receiptFor(journal, { effect: 'occurred', resulting_subject: subject }),
          },
          undefined,
          '2026-09-10T10:01:00.000Z',
        );
        expect(reported.result.code).toBe(valid ? 'RECEIPT_ACCEPTED' : 'INVALID_ATTEMPT_OUTCOME');
        if (!valid) expect(reported.projection.attempts).toEqual(started.projection.attempts);
        const observation = structuredClone(recoveryFor(journal, 'effect_occurred'));
        observation.evidence.resulting_subject = subject;
        observation.evidence_digest = executionDigest(observation.evidence);
        const evidence = [recoveryFor(journal, 'executor_stopped'), observation];
        const recovered = operate(
          expired.journal,
          {
            kind: 'reconcile',
            ...target,
            disposition: 'effect_confirmed',
            evidence_ids: evidence.map((item) => item.evidence.id),
            reason: 'Verify resulting subject',
          },
          humanActor(journal),
          '2026-09-10T10:06:00.000Z',
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
      const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
      const reported = operate(
        started.journal,
        { kind: 'submit_receipt', receipt: receiptFor(journal, { status, effect: 'none' }) },
        undefined,
        '2026-09-10T10:01:00.000Z',
      );
      expect(reported.result.code).toBe('RECEIPT_ACCEPTED');
      expect(reported.projection.attempts[0]?.binding.subject).toEqual(
        journal.execution.action_request.request.binding.subject,
      );
      expect(reported.projection.attempts[0]?.resulting_subject).toBeNull();
      expect(reported.projection.receipts[0]?.envelope.receipt.binding.subject).toEqual(
        journal.execution.action_request.request.binding.subject,
      );
      const replacement = operate(
        reported.journal,
        {
          kind: 'replace',
          previous_claim: target.claim,
          claim_id: 'claim_b',
          attempt_id: 'attempt_b',
          executor: executorA,
          valid_until: '2026-09-10T10:05:00.000Z',
          evidence_ids: [],
        },
        undefined,
        '2026-09-10T10:01:00.000Z',
      );
      expect(replacement.result.code).toBe(status === 'succeeded' ? 'REQUEST_CLOSED' : 'CLAIM_ACQUIRED');
      expect(replacement.projection.request_status).toBe(status === 'succeeded' ? 'satisfied' : 'open');
    },
  );
  it('retains changed recovery observations even when the reconciliation operation is replayed exactly', async () => {
    const { journal } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const expired = operate(
      started.journal,
      { kind: 'expire', ...target },
      controllerActor(journal),
      '2026-09-10T10:05:00.000Z',
    );
    const evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'no_effect')];
    const resolved = operate(
      expired.journal,
      {
        kind: 'reconcile',
        ...target,
        disposition: 'no_effect_confirmed',
        evidence_ids: evidence.map((item) => item.evidence.id),
        reason: 'Independently verified no effect',
      },
      humanActor(journal),
      '2026-09-10T10:06:00.000Z',
      evidence,
    );
    const changed = structuredClone(resolved.context);
    changed.recovery_evidence[1]!.evidence.kind = 'effect_occurred';
    changed.recovery_evidence[1]!.evidence_digest = executionDigest(changed.recovery_evidence[1]!.evidence);
    const conflicted = applyExecutionOperation(resolved.journal, changed, resolved.operation);
    expect(conflicted.ok).toBe(true);
    if (!conflicted.ok) return;
    expect(conflicted.value.result.code).toBe('IDENTITY_CONFLICT');
    expect(conflicted.value.projection.conflicts[0]?.namespace).toBe('recovery_evidence');
    expect(conflicted.value.projection.attempts).toEqual(resolved.projection.attempts);
    expect(replayExecutionJournal(conflicted.value.journal)).toEqual({ ok: true, value: conflicted.value.projection });
    const repeated = applyExecutionOperation(conflicted.value.journal, changed, resolved.operation);
    expect(repeated.ok && repeated.value.replayed).toBe(true);
    if (repeated.ok) expect(repeated.value.journal).toEqual(conflicted.value.journal);
    const delivery = operationFor(
      conflicted.value.journal,
      changed.actor,
      resolved.operation.command,
      'new_recovery_delivery',
    );
    const redelivered = applyExecutionOperation(conflicted.value.journal, changed, delivery);
    expect(redelivered.ok).toBe(true);
    if (!redelivered.ok) return;
    expect(redelivered.value.replayed).toBe(false);
    expect(redelivered.value.result).toEqual(conflicted.value.result);
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
    if (collision.ok) expect(collision.value.projection.conflicts.at(-1)?.namespace).toBe('operation');
  });

  it('keeps replaced execution uncertainty visible when its pending replacement is cancelled', async () => {
    const { journal, context } = await initialExecution('repeatable_with_overlap');
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const expired = operate(
      started.journal,
      { kind: 'expire', ...target },
      controllerActor(journal),
      '2026-09-10T10:05:00.000Z',
    );
    const replaced = operate(
      expired.journal,
      {
        kind: 'replace',
        previous_claim: target.claim,
        claim_id: 'claim_b',
        attempt_id: 'attempt_b',
        executor: executorB,
        valid_until: '2026-09-10T10:10:00.000Z',
        evidence_ids: [],
      },
      { kind: 'executor', executor: executorB },
      '2026-09-10T10:05:00.000Z',
    );
    const cancelled = operate(
      replaced.journal,
      { kind: 'cancel', reason: 'Stop all execution' },
      controllerActor(journal),
      '2026-09-10T10:06:00.000Z',
    );
    const snapshot = { ...context.snapshot, evaluation_time: '2026-09-10T10:06:00.000Z' };
    const whileActive = projectControllerExecution(replaced.journal, snapshot);
    expect(whileActive.ok && whileActive.value.execution.status).toBe('in_flight');
    expect(replaced.projection.attempts[0]?.status).toBe('unknown_outcome');
    const invalidated = operate(
      cancelled.journal,
      { kind: 'invalidate', reason: 'integrity_failure' },
      controllerActor(journal),
      snapshot.evaluation_time,
    );
    const afterInvalidation = projectControllerExecution(invalidated.journal, snapshot);
    expect(afterInvalidation.ok && afterInvalidation.value.execution.status).toBe('reconciliation_required');
    if (afterInvalidation.ok && afterInvalidation.value.execution.status === 'reconciliation_required')
      expect(afterInvalidation.value.execution.attempt_id).toBe('attempt_a');
    const stopped = recoveryFor(journal, 'executor_stopped');
    const abandoned = operate(
      replaced.journal,
      {
        kind: 'reconcile',
        ...target,
        disposition: 'abandon',
        evidence_ids: [stopped.evidence.id],
        reason: 'Abandon this request',
      },
      humanActor(journal),
      snapshot.evaluation_time,
      [stopped],
    );
    expect(abandoned.projection.request_status).toBe('cancelled');
    expect(abandoned.projection.claims[1]?.status).toBe('cancelled');
    expect(abandoned.projection.attempts[1]?.status).toBe('cancelled');
    expect(abandoned.projection.attempts[0]).toMatchObject({
      status: 'unknown_outcome',
      effect: 'unknown',
      resolution: { disposition: 'abandon' },
    });
    const afterAbandonment = projectControllerExecution(abandoned.journal, snapshot);
    expect(afterAbandonment.ok && afterAbandonment.value.execution.status).toBe('idle');
    const forbiddenRetry = operate(
      abandoned.journal,
      {
        ...grant,
        claim_id: 'claim_after_abandonment',
        attempt_id: 'attempt_after_abandonment',
        valid_until: '2026-09-10T10:10:00.000Z',
      },
      undefined,
      snapshot.evaluation_time,
    );
    expect(forbiddenRetry.result.code).toBe('REQUEST_CLOSED');
    expect(forbiddenRetry.projection.attempts).toHaveLength(2);
    const unresolved = projectControllerExecution(cancelled.journal, snapshot);
    expect(unresolved.ok && unresolved.value.execution.status).toBe('reconciliation_required');
    if (unresolved.ok && unresolved.value.execution.status === 'reconciliation_required')
      expect(unresolved.value.execution.attempt_id).toBe('attempt_a');
    const evidence = [recoveryFor(journal, 'executor_stopped'), recoveryFor(journal, 'no_effect')];
    const resolved = operate(
      cancelled.journal,
      {
        kind: 'reconcile',
        ...target,
        disposition: 'no_effect_confirmed',
        evidence_ids: evidence.map((item) => item.evidence.id),
        reason: 'Old executor stopped without effect',
      },
      humanActor(journal),
      snapshot.evaluation_time,
      evidence,
    );
    expect(resolved.result.code).toBe('ATTEMPT_RECONCILED');
    const finished = projectControllerExecution(resolved.journal, snapshot);
    expect(finished.ok && finished.value.execution.status).toBe('idle');
    expect(resolved.projection.request_status).toBe('cancelled');
  });
  it('records a valid changed Action Request under the existing logical identity as a durable conflict', async () => {
    const { journal } = await initialExecution();
    const proposal = structuredClone(journal.execution.action_request);
    proposal.request.inputs.push({
      role: 'release_manifest',
      artifact: { id: 'another_input', digest: executionDigest('input') },
    });
    proposal.request_digest = executionDigest(proposal.request);
    const conflicted = operate(journal, { kind: 'register_request', request: proposal }, controllerActor(journal));
    expect(conflicted.result.code).toBe('IDENTITY_CONFLICT');
    expect(conflicted.projection.conflicts[0]?.namespace).toBe('request');
    const denied = operate(conflicted.journal, grant);
    expect(denied.result.code).toBe('UNRESOLVED_CONFLICT');
    const record = conflicted.projection.conflicts[0]!;
    const resolved = operate(
      denied.journal,
      {
        kind: 'resolve_conflict',
        conflict_id: record.id,
        original_digest: record.original_digest,
        reason: 'Keep the originally admitted request',
      },
      humanActor(journal),
    );
    expect(resolved.result.code).toBe('CONFLICT_RESOLVED');
    expect(resolved.journal.execution.action_request).toEqual(journal.execution.action_request);
    expect(resolved.projection.conflicts[0]?.incoming_digest).toBe(proposal.request_digest);
    expect(
      operate(resolved.journal, {
        ...grant,
        claim_id: 'claim_after_resolution',
        attempt_id: 'attempt_after_resolution',
      }).result.code,
    ).toBe('CLAIM_ACQUIRED');
  });

  it('does not clear an unknown effect when the human resolves only an identity conflict', async () => {
    const { journal } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const collided = operate(started.journal, { ...grant, valid_until: '2026-09-10T10:07:00.000Z' });
    expect(collided.result.code).toBe('IDENTITY_CONFLICT');
    const expired = operate(
      collided.journal,
      { kind: 'expire', ...target },
      controllerActor(journal),
      '2026-09-10T10:05:00.000Z',
    );
    const record = collided.projection.conflicts[0]!;
    const resolved = operate(
      expired.journal,
      {
        kind: 'resolve_conflict',
        conflict_id: record.id,
        original_digest: record.original_digest,
        reason: 'Keep original',
      },
      humanActor(journal),
      '2026-09-10T10:05:00.000Z',
    );
    expect(resolved.projection.attempts[0]?.resolution).toBeNull();
    const projection = projectControllerExecution(resolved.journal, {
      ...started.context.snapshot,
      evaluation_time: '2026-09-10T10:05:00.000Z',
    });
    expect(projection.ok && projection.value.execution.status).toBe('reconciliation_required');
  });

  it.each(['missing_stop', 'wrong_attempt', 'wrong_subject', 'bad_digest', 'contradictory'] as const)(
    'rejects %s recovery evidence without altering the unknown Attempt',
    async (mode) => {
      const { journal } = await initialExecution('reconciliation_required', 'release-to-publish');
      const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
      const expired = operate(
        started.journal,
        { kind: 'expire', ...target },
        controllerActor(journal),
        '2026-09-10T10:05:00.000Z',
      );
      const fact = structuredClone(recoveryFor(journal, 'no_effect'));
      if (mode === 'wrong_attempt') fact.evidence.attempt_id = 'other_attempt';
      if (mode === 'wrong_subject') fact.evidence.binding.subject.content_digest = executionDigest('other');
      fact.evidence_digest = mode === 'bad_digest' ? executionDigest('tampered') : executionDigest(fact.evidence);
      const evidence = mode === 'missing_stop' ? [fact] : [fact, recoveryFor(journal, 'executor_stopped')];
      if (mode === 'contradictory') evidence.push(recoveryFor(journal, 'effect_occurred'));
      const result = operate(
        expired.journal,
        {
          kind: 'reconcile',
          ...target,
          disposition: 'no_effect_confirmed',
          evidence_ids: evidence.map((item) => item.evidence.id),
          reason: 'Request retry',
        },
        humanActor(journal),
        '2026-09-10T10:06:00.000Z',
        evidence,
      );
      expect(result.result.disposition).toBe('rejected');
      expect(result.projection.attempts).toEqual(expired.projection.attempts);
      expect(result.projection.request_status).toBe('open');
    },
  );

  it('preserves accepted proof on normal closure but projects explicit integrity invalidation', async () => {
    const { journal } = await initialExecution();
    const started = operate(operate(journal, grant).journal, { kind: 'start', ...target });
    const accepted = operate(
      started.journal,
      { kind: 'submit_receipt', receipt: receiptFor(journal) },
      undefined,
      '2026-09-10T10:01:00.000Z',
    );
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
    fixture.request.request.constraints.valid_until = '2026-09-10T10:06:00.000Z';
    fixture.request.request_digest = executionDigest(fixture.request.request);
    fixture.policy.rules.request.request_digest = fixture.request.request_digest;
    fixture.policy.digest = executionDigest(fixture.policy.rules);
    const initial = createExecutionJournal(fixture.context, fixture.request, fixture.policy);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const claimed = operate(initial.value, grant);
    expect(
      operate(claimed.journal, { kind: 'renew', ...target, valid_until: '2026-09-10T10:07:00.000Z' }).result.code,
    ).toBe('INVALID_CLAIM_DEADLINE');
    const context = {
      ...claimed.context,
      snapshot: { ...claimed.context.snapshot, evaluation_time: '2026-09-10T09:59:59.999Z' },
    };
    const reversed = applyExecutionOperation(
      claimed.journal,
      context,
      operationFor(claimed.journal, context.actor, { kind: 'start', ...target }),
    );
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.diagnostics[0]?.code).toBe('TIME_REVERSED');
  });
});
