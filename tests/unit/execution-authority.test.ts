import { describe, expect, it } from 'vitest';
import {
  applyExecutionOperation,
  createExecutionJournal,
  executionDigest,
  projectControllerExecution,
  replayExecutionJournal,
} from '../../scripts/execution-contract/model.js';
import { executionAdmissionDigest, type ExecutionAdmission } from '../../scripts/execution-contract/authority.js';
import {
  executionFixture,
  executorA,
  grant,
  operationFor,
  receiptAdmissionFor,
  receiptFor,
  target,
} from '../fixtures/execution-contract.js';

async function admittedExecution() {
  const fixture = await executionFixture();
  const admissions = new Set<string>();
  const authority = { isAdmitted: (digest: string) => admissions.has(digest) };
  const admit = (value: ExecutionAdmission) => admissions.add(executionAdmissionDigest(value));
  admit({ kind: 'create', ...fixture });
  const created = createExecutionJournal(fixture.context, fixture.request, fixture.policy, authority);
  if (!created.ok) throw new Error(JSON.stringify(created));
  return { ...fixture, journal: created.value, authority, admit };
}

describe('Independent execution authority', () => {
  it('allows an independently admitted policy rotation without granting the revoked actor authority', async () => {
    const { journal, context, authority, admit } = await admittedExecution();
    const current = structuredClone(context);
    const replacement = { id: 'current_controller', digest: executionDigest('current controller') };
    current.snapshot.policy.rules.authorities = current.snapshot.policy.rules.authorities.map((item) =>
      item.type === 'threadloop' ? { ...item, identity: replacement } : item,
    );
    current.snapshot.policy.digest = executionDigest(current.snapshot.policy.rules);
    const revoked = operationFor(journal, current.actor, { kind: 'cancel', reason: 'Revoked actor' });
    admit({ kind: 'operation', execution_digest: journal.execution_digest, context: current, operation: revoked });
    const denied = applyExecutionOperation(journal, current, revoked, authority);
    expect(denied.ok && denied.value.result.code).toBe('AUTHORITY_MISMATCH');
    current.actor = { kind: 'threadloop', identity: replacement };
    const operation = operationFor(journal, current.actor, { kind: 'cancel', reason: 'Current authority' });
    admit({ kind: 'operation', execution_digest: journal.execution_digest, context: current, operation });
    const accepted = applyExecutionOperation(journal, current, operation, authority);
    expect(accepted.ok && accepted.value.result.code).toBe('REQUEST_CANCELLED');
    expect(accepted.ok && accepted.value.journal.execution.action_request).toEqual(journal.execution.action_request);
  });

  it('rejects a fabricated current policy that grants the caller human authority', async () => {
    const { journal, context, authority } = await admittedExecution();
    const forged = structuredClone(context);
    forged.actor = { kind: 'human', identity: { id: 'attacker', digest: executionDigest('attacker') } };
    forged.snapshot.policy.rules.authorities.push({ type: 'human', identity: forged.actor.identity });
    forged.snapshot.policy.digest = executionDigest(forged.snapshot.policy.rules);
    const result = applyExecutionOperation(
      journal,
      forged,
      operationFor(journal, forged.actor, { kind: 'cancel', reason: 'Forged authority' }),
      authority,
    );
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'UNTRUSTED_EXECUTION_INPUT' }] });
    expect(replayExecutionJournal(journal, authority)).toMatchObject({
      ok: true,
      value: { request_status: 'open', revision: 0 },
    });
  });

  it('rejects executor-added admissions even when every hash and binding is internally valid', async () => {
    const initial = await admittedExecution();
    let journal = initial.journal;
    const context = structuredClone(initial.context);
    context.actor = { kind: 'executor', executor: executorA };
    for (const command of [grant, { kind: 'start', ...target }] as const) {
      const operation = operationFor(journal, context.actor, command);
      initial.admit({ kind: 'operation', execution_digest: journal.execution_digest, context, operation });
      const applied = applyExecutionOperation(journal, context, operation, initial.authority);
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      journal = applied.value.journal;
    }
    context.snapshot.evaluation_time = '2026-09-10T10:01:00.000Z';
    const receipt = receiptFor(journal);
    const operation = operationFor(journal, context.actor, { kind: 'submit_receipt', receipt });
    // The authority admitted the authenticated delivery, without an independently verified admission.
    initial.admit({ kind: 'operation', execution_digest: journal.execution_digest, context, operation });
    const raw = applyExecutionOperation(journal, context, operation, initial.authority);
    expect(raw.ok && raw.value.result.code).toBe('RECEIPT_ADMISSION_MISMATCH');
    context.receipt_admissions = [receiptAdmissionFor(journal, receipt)];
    const forged = applyExecutionOperation(journal, context, operation, initial.authority);
    expect(forged).toMatchObject({ ok: false, diagnostics: [{ code: 'UNTRUSTED_EXECUTION_INPUT' }] });
    expect(replayExecutionJournal(journal, initial.authority)).toMatchObject({
      ok: true,
      value: { request_status: 'open', attempts: [{ status: 'running', effect: 'unknown' }] },
    });
  });

  it('binds admission to the command, journal, and current snapshot and fails closed on authority failure', async () => {
    const { journal, context, authority, admit } = await admittedExecution();
    const operation = operationFor(journal, context.actor, { kind: 'cancel', reason: 'Authorized cancellation' });
    admit({ kind: 'operation', execution_digest: journal.execution_digest, context, operation });
    const substituted = { ...operation, command: { kind: 'invalidate', reason: 'integrity_failure' } };
    expect(applyExecutionOperation(journal, context, substituted, authority).ok).toBe(false);
    const applied = applyExecutionOperation(journal, context, operation, authority);
    if (!applied.ok) throw new Error(JSON.stringify(applied));
    expect(applyExecutionOperation(applied.value.journal, context, operation, authority).ok).toBe(false);
    expect(projectControllerExecution(journal, context.snapshot, authority).ok).toBe(false);
    admit({ kind: 'projection', execution_digest: journal.execution_digest, snapshot: context.snapshot });
    expect(projectControllerExecution(journal, context.snapshot, authority).ok).toBe(true);
    const unavailable = {
      isAdmitted: () => {
        throw new Error('Admission service unavailable');
      },
    };
    expect(replayExecutionJournal(journal, unavailable)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'UNTRUSTED_EXECUTION_INPUT' }],
    });
    expect(replayExecutionJournal(applied.value.journal, { isAdmitted: () => false }).ok).toBe(false);
  });
});
