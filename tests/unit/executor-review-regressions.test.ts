import { describe, expect, it } from 'vitest';
import { digest, type ValidationResult } from '../../scripts/contract-kernel/kernel.js';
import { publishedExecutorSchemas, type ExecutorResult } from '../../scripts/executor-contract/contracts.js';
import { buildGaapRequest, mapGaapResult } from '../../scripts/executor-contract/gaap.js';
import { validateGaapReceipt, validateGaapRequest } from '../../scripts/executor-contract/gaap-validation.js';
import type { GaapEvent, GaapReceipt, GaapRequest } from '../../scripts/executor-contract/gaap-types.js';
import { validateExecutorRequest, validateExecutorResult } from '../../scripts/executor-contract/validation.js';
import {
  executorFixture,
  executorJson,
  gaapBytes,
  gaapMappingFixture,
  nativeGaapFixture,
  resealGaap,
} from '../fixtures/executor-contract.js';
import { operate } from '../fixtures/execution-contract.js';
import { ajv, codes } from '../fixtures/contracts.js';

const requestSchema = ajv().compile(publishedExecutorSchemas()['executor-request']!);

/** The ledger check that rejected a receipt, identified by its message. */
function ledgerFailure(result: ValidationResult<unknown>) {
  return result.ok ? 'accepted' : `${result.diagnostics[0]!.code}: ${result.diagnostics[0]!.message}`;
}

describe('Executor schema and validator parity', () => {
  it.each(['\n', '\r', '\r\n', ' ', ' '])(
    'rejects a digest ending in a line separator %j (existing regex behavior)',
    async (suffix) => {
      const { request } = await gaapMappingFixture();
      request.request.mapping_policy.digest += suffix;
      request.request_digest = digest(request.request);
      expect(requestSchema(request)).toBe(false);
      expect(codes(validateExecutorRequest(request))).toContain('SCHEMA_INVALID');
    },
  );
  it('rejects duplicate mapping families even with different evidence types in schema and mapper', async () => {
    const fixture = await gaapMappingFixture();
    fixture.mapping.policy.evidence_mapping.push({
      ...fixture.mapping.policy.evidence_mapping[0]!,
      evidence_types: ['artifact'],
    });
    fixture.mapping.policy_digest = digest(fixture.mapping.policy);
    fixture.request.request.mapping_policy.digest = fixture.mapping.policy_digest;
    fixture.request.request_digest = digest(fixture.request.request);
    expect(ajv().compile(publishedExecutorSchemas()['gaap-mapping-policy']!)(fixture.mapping)).toBe(false);
    expect(codes(buildGaapRequest(fixture.request, fixture.mapping))).toEqual(['SCHEMA_INVALID']);
  });
  it.each(['human', 'policies', 'evidence_types'])(
    'rejects %s in both the published schema and validator',
    async (mutation) => {
      const { request } = await gaapMappingFixture();
      const parameters = request.request.parameters;
      if (mutation === 'human') Reflect.set(request.request.action_request.request, 'actor', 'human');
      if (mutation === 'policies') parameters.policies.push(structuredClone(parameters.policies[0]!));
      if (mutation === 'evidence_types')
        parameters.required_verification.evidence_types.push(parameters.required_verification.evidence_types[0]!);
      request.request.action_request.request_digest = digest(request.request.action_request.request);
      request.request_digest = digest(request.request);
      expect(requestSchema(request)).toBe(false);
      expect(codes(validateExecutorRequest(request))).toContain('SCHEMA_INVALID');
    },
  );
});

describe('GAAP ledger consistency beyond the upstream schema', () => {
  it.each([
    ['nonterminal', 'GAAP_NONTERMINAL_RESULT'],
    ['approval', 'Approval records require approval evidence'],
    ['tool_execution', 'Tool execution requires tool_execution evidence'],
    ['mutation', 'Mutation requires artifact evidence'],
    ['interruption', 'Interruption records require interruption evidence'],
  ])('requires semantic checks beyond the immutable upstream schema: %s', async (kind, reason) => {
    const { request } = await nativeGaapFixture();
    const receipt = await executorJson<GaapReceipt>(
      `upstream/gaap/${kind === 'interruption' ? 'interrupted' : 'completed'}.json`,
    );
    if (kind === 'nonterminal') receipt.body.terminal_status = 'executing';
    for (const event of receipt.body.events) {
      if (kind === 'approval' && event.event_type === 'approval_recorded')
        event.approval.evidence.evidence_type = 'artifact';
      if (
        (kind === 'tool_execution' && event.event_type === 'tool_execution') ||
        (kind === 'mutation' && event.event_type === 'mutation')
      )
        event.evidence.forEach((entry) => {
          entry.evidence_type = 'command_output';
        });
      if (kind === 'interruption' && event.event_type === 'interruption') event.evidence.evidence_type = 'artifact';
    }
    resealGaap(receipt);
    const schema = await executorJson<object>('upstream/gaap/terminal-run-receipt.schema.json');
    expect(ajv().compile(schema)(receipt)).toBe(true);
    expect(ledgerFailure(validateGaapReceipt(receipt, request))).toContain(reason);
  });
  it('rejects duplicate native approval identities', async () => {
    const { request, receipt } = await nativeGaapFixture();
    const approval = receipt.body.events.find((event) => event.event_type === 'approval_recorded');
    if (!approval || approval.event_type !== 'approval_recorded') throw new Error('Missing approval');
    request.approval_context = [approval.approval, structuredClone(approval.approval)];
    expect(ledgerFailure(validateGaapRequest(request))).toContain('must be unique');
  });
  it('rejects identical policy identities with different property insertion order', async () => {
    const { request } = await nativeGaapFixture();
    const policy = request.policies[0]!;
    request.policies.push({ digest: policy.digest, version: policy.version, name: policy.name });
    expect(ledgerFailure(validateGaapRequest(request))).toContain('must be unique');
  });
  it('requires recorded approvals to target the subject current at that event', async () => {
    const { request, receipt } = await nativeGaapFixture();
    const approval = receipt.body.events.find((event) => event.event_type === 'approval_recorded');
    if (!approval || approval.event_type !== 'approval_recorded') throw new Error('Missing approval');
    const later = structuredClone(approval);
    later.approval.approval_id = 'later_approval';
    later.approval.subject_digest = receipt.body.resulting_subject_digest;
    receipt.body.events.splice(-1, 0, later);
    expect(validateGaapReceipt(resealGaap(receipt), request).ok).toBe(true);
    later.approval.subject_digest = 'sha256:' + '9'.repeat(64);
    expect(ledgerFailure(validateGaapReceipt(resealGaap(receipt), request))).toContain('subject current at that event');
  });
  it('invalidates a passing verification when the same subject later fails verification', async () => {
    const { request, receipt } = await nativeGaapFixture();
    const index = receipt.body.events.findIndex((event) => event.event_type === 'verification');
    const verification = receipt.body.events[index]!;
    if (verification.event_type !== 'verification') throw new Error('Missing verification');
    receipt.body.events.splice(index + 1, 0, { ...structuredClone(verification), verdict: 'FAIL' });
    expect(ledgerFailure(validateGaapReceipt(resealGaap(receipt), request))).toContain('latest-subject independent');
  });
  it('rejects a completed transition that skips verifying (existing route protection)', async () => {
    const { receipt, request } = await nativeGaapFixture();
    // Drop verification too, so the route itself, not an out-of-state verification event, is what fails.
    receipt.body.events = receipt.body.events.filter(
      (event) =>
        event.event_type !== 'verification' && !(event.event_type === 'status_transition' && event.to === 'verifying'),
    );
    const terminal = receipt.body.events.at(-1)!;
    if (terminal.event_type !== 'status_transition') throw new Error('Missing terminal transition');
    terminal.from = 'executing';
    expect(ledgerFailure(validateGaapReceipt(resealGaap(receipt), request))).toContain('lifecycle');
  });
  it('rejects a terminal reason that contradicts the final transition', async () => {
    const { receipt, request } = await nativeGaapFixture();
    receipt.body.terminal_reason = 'runtime.hard_stop';
    expect(ledgerFailure(validateGaapReceipt(resealGaap(receipt), request))).toContain('Terminal status and reason');
  });
  it.each([
    ['tool_execution', 'require the executing state'],
    ['mutation', 'require the executing state'],
    ['verification', 'require the verifying state'],
  ])('rejects %s outside its lifecycle state', async (kind, reason) => {
    const { receipt, request } = await nativeGaapFixture();
    if (kind === 'mutation')
      receipt.body.events = receipt.body.events.filter((event) => event.event_type !== 'tool_execution');
    const events = receipt.body.events;
    if (kind === 'verification') {
      const index = events.findIndex((event) => event.event_type === 'verification');
      const [verification] = events.splice(index, 1);
      events.splice(
        events.findIndex((event) => event.event_type === 'status_transition' && event.to === 'verifying'),
        0,
        verification!,
      );
    } else {
      const index = events.findIndex((event) => event.event_type === 'status_transition' && event.to === 'executing');
      const [transition] = events.splice(index, 1);
      const end = events.findIndex((event) => event.event_type === kind);
      events.splice(end + 1, 0, transition!);
    }
    expect(ledgerFailure(validateGaapReceipt(resealGaap(receipt), request))).toContain(reason);
  });
});

describe('Mapped results and terminal causes', () => {
  it.each([
    ['missing', 'RESULT_VERIFICATION_MISMATCH'],
    ['same_actor', 'RESULT_VERIFICATION_MISMATCH'],
    ['missing_evidence', 'RESULT_VERIFICATION_MISMATCH'],
    ['later_failure', 'RESULT_VERIFICATION_MISMATCH'],
    ['source_id', 'RESULT_SOURCE_MISMATCH'],
    ['source_digest', 'RESULT_SOURCE_MISMATCH'],
  ])('rejects inconsistent direct success evidence: %s', async (mutation, code) => {
    const fixture = await gaapMappingFixture();
    const mapped = mapGaapResult(fixture.request, fixture.mapping, gaapBytes(fixture.receipt), fixture.observation);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped));
    const envelope = mapped.value;
    const result = envelope.result;
    if (mutation === 'missing') result.verification = [];
    if (mutation === 'same_actor') result.verification[0]!.actor_id = fixture.request.request.executor.id;
    if (mutation === 'missing_evidence')
      result.verification[0]!.evidence = result.verification[0]!.evidence.filter(
        (evidence) => evidence.evidence_type !== 'command_output',
      );
    if (mutation === 'later_failure')
      result.verification.push({ ...structuredClone(result.verification[0]!), verdict: 'FAIL' });
    if (mutation === 'source_id') result.source_receipt.id = 'another_receipt';
    if (mutation === 'source_digest') result.source_receipt.digest = 'f'.repeat(64);
    envelope.result_digest = digest(result);
    expect(codes(validateExecutorResult(envelope, fixture.request))).toEqual([code]);
  });
  it('retains an unknown-effect changed-subject report solely for recovery', async () => {
    const fixture = await gaapMappingFixture();
    const history = await executorFixture();
    const mapped = mapGaapResult(fixture.request, fixture.mapping, gaapBytes(fixture.receipt), fixture.observation);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped));
    const envelope = mapped.value;
    const receipt = envelope.result.attempt_receipt;
    receipt.receipt.status = 'failed';
    receipt.receipt.effect = 'unknown';
    receipt.receipt.resulting_subject!.content_digest = 'f'.repeat(64);
    envelope.result.reason.code = 'failed';
    receipt.receipt_digest = digest(receipt.receipt);
    envelope.result_digest = digest(envelope.result);
    expect(validateExecutorResult(envelope, fixture.request).ok).toBe(true);
    // The executor did not observe an attributable mutation. Synthetic admission still requires recovery.
    const admitted = operate(
      history.started.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T10:01:00.000Z',
    );
    expect(admitted.projection.attempts.at(-1)?.status).toBe('unknown_outcome');
  });
  it.each(['completed', 'interrupted'])('maps omitted upstream evidence locators in %s receipts', async (name) => {
    const fixture = await gaapMappingFixture(name);
    for (const event of fixture.receipt.body.events) {
      if ('evidence' in event) {
        for (const evidence of Array.isArray(event.evidence) ? event.evidence : [event.evidence])
          Reflect.deleteProperty(evidence, 'locator');
      }
      if (event.event_type === 'approval_recorded') Reflect.deleteProperty(event.approval.evidence, 'locator');
    }
    const result = mapGaapResult(fixture.request, fixture.mapping, gaapBytes(fixture.receipt), fixture.observation);
    expect(result.ok && result.value.result.evidence.every((evidence) => evidence.locator === null)).toBe(true);
  });
  it('maps the causal denied decision even when a later unrelated allow was recorded', async () => {
    const fixture = await gaapMappingFixture('denied-effect');
    const denied = fixture.receipt.body.events.find((event) => event.event_type === 'protected_effect_decision')!;
    if (denied.event_type !== 'protected_effect_decision') throw new Error('Missing denial');
    fixture.receipt.body.events.splice(-1, 0, {
      ...denied,
      decision_id: 'unrelated_allow',
      decision: { outcome: 'allow', code: 'permission.policy_allowed', effects: [] },
    });
    const result = mapGaapResult(fixture.request, fixture.mapping, gaapBytes(fixture.receipt), fixture.observation);
    expect(result.ok && result.value.result.reason.code).toBe('effect_denied');
  });
  it('rejects an ask that is relabeled as an unrelated terminal cause', async () => {
    const fixture = await gaapMappingFixture('blocked');
    fixture.receipt.body.terminal_reason = 'runtime.hard_stop';
    const terminal = fixture.receipt.body.events.at(-1)!;
    if (terminal.event_type !== 'status_transition') throw new Error('Missing terminal transition');
    terminal.reason = 'runtime.hard_stop';
    const result = mapGaapResult(fixture.request, fixture.mapping, gaapBytes(fixture.receipt), fixture.observation);
    expect(codes(result)).toEqual(['GAAP_ONESHOT_AUTHORITY']);
  });
  it('preserves native resumability but rejects a resumed ask in the one-shot mapping', async () => {
    const fixture = await gaapMappingFixture();
    const events = fixture.receipt.body.events;
    const decision = events.find((event) => event.event_type === 'protected_effect_decision')!;
    if (decision.event_type !== 'protected_effect_decision') throw new Error('Missing decision');
    const ask: GaapEvent = {
      ...decision,
      subject_digest: fixture.receipt.body.initial_subject_digest,
      decision_id: 'earlier_ask',
      decision: { outcome: 'ask', code: 'permission.policy_requires_approval', effects: [] },
    };
    const executing = events.findIndex((event) => event.event_type === 'status_transition' && event.to === 'executing');
    events.splice(
      executing,
      0,
      ask,
      {
        event_type: 'status_transition',
        sequence: 0,
        from: 'planning',
        to: 'awaiting_authority',
        reason: 'authority.required',
      },
      { event_type: 'status_transition', sequence: 0, from: 'awaiting_authority', to: 'planning', reason: null },
    );
    const native = await executorJson<GaapRequest>('fixtures/gaap-request.json');
    expect(validateGaapReceipt(resealGaap(fixture.receipt), native).ok).toBe(true);
    const result = mapGaapResult(fixture.request, fixture.mapping, gaapBytes(fixture.receipt), fixture.observation);
    expect(codes(result)).toEqual(['GAAP_ONESHOT_AUTHORITY']);
  });
  it.each(['occurred_without_mutation', 'none_changed_revision', 'none_changed_digest'])(
    'rejects the result inconsistency %s',
    async (mutation) => {
      const fixture = await gaapMappingFixture();
      const mapped = mapGaapResult(fixture.request, fixture.mapping, gaapBytes(fixture.receipt), fixture.observation);
      if (!mapped.ok) throw new Error(JSON.stringify(mapped));
      const result: ExecutorResult = mapped.value;
      const receipt = result.result.attempt_receipt.receipt;
      if (mutation === 'occurred_without_mutation') receipt.effect = 'occurred';
      else {
        // A non-success result must obey no-effect subject equality too.
        receipt.status = 'blocked';
        result.result.reason.code = 'blocked';
        if (!receipt.resulting_subject || receipt.resulting_subject.kind !== 'repository')
          throw new Error('Missing subject');
        if (mutation === 'none_changed_revision') receipt.resulting_subject.revision = 'different_revision';
        else receipt.resulting_subject.content_digest = 'f'.repeat(64);
      }
      result.result.attempt_receipt.receipt_digest = digest(receipt);
      result.result_digest = digest(result.result);
      expect(codes(validateExecutorResult(result, fixture.request))).toEqual(['RESULT_EFFECT_MISMATCH']);
    },
  );
});
