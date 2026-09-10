import { describe, expect, it } from 'vitest';
import { executorFixture } from '../fixtures/executor-contract.js';
import { executionDigest } from '../../scripts/execution-contract/model.js';
import { validateExecutorRequest, validateExecutorResult } from '../../scripts/executor-contract/validation.js';
import { receiptFor } from '../fixtures/execution-contract.js';
import type { ExecutorResult } from '../../scripts/executor-contract/contracts.js';

describe('Executor contract candidates', () => {
  it.each([
    ['unknown version', { schema_version: 'threadloop.executor/999' }],
    ['unknown field', { admission: { approved: true } }],
  ])('rejects %s even with a fresh envelope hash', async (_name, changes) => {
    const { envelope } = await executorFixture();
    const request = { ...envelope.request, ...changes };
    expect(validateExecutorRequest({ request, request_digest: executionDigest(request) }).ok).toBe(false);
  });
  it('validates a complete request without asserting runtime authority', async () => {
    const { envelope } = await executorFixture();
    expect(validateExecutorRequest(envelope)).toEqual({ ok: true, value: envelope });
  });
  it('rejects changed request contents and forged nested Action Request digests', async () => {
    const { envelope } = await executorFixture();
    envelope.request.parameters.task.instructions = 'Different task';
    expect(validateExecutorRequest(envelope).ok).toBe(false);
    envelope.request_digest = executionDigest(envelope.request);
    envelope.request.action_request.request_digest = 'f'.repeat(64);
    envelope.request_digest = executionDigest(envelope.request);
    expect(validateExecutorRequest(envelope).ok).toBe(false);
  });
  it('validates a correlated result but rejects a changed claim even with fresh hashes', async () => {
    const fixture = await executorFixture();
    const result: ExecutorResult['result'] = {
      schema_version: 'threadloop.executor/0.1',
      kind: 'result',
      request_digest: fixture.envelope.request_digest,
      attempt_receipt: receiptFor(fixture.journal),
      source_receipt: { type: 'terminal_run_receipt', id: 'source_a', digest: 'a'.repeat(64) },
      effects: [],
      verification: [
        {
          actor_id: 'independent_verifier',
          subject_digest: fixture.envelope.request.action_request.request.binding.subject.content_digest,
          verdict: 'PASS',
          evidence: [{ evidence_type: 'command_output', digest: 'b'.repeat(64), locator: null }],
        },
      ],
      evidence: [],
      usage: { cost_micros: 0, elapsed_ms: 1, model_tokens: 0, tool_calls: 0 },
      reason: { code: 'completed', message: 'Completed the requested gates.' },
    };
    result.attempt_receipt.receipt.evidence.push({
      id: result.source_receipt.id,
      digest: result.source_receipt.digest,
    });
    result.attempt_receipt.receipt_digest = executionDigest(result.attempt_receipt.receipt);
    const envelope = { result, result_digest: executionDigest(result) };
    expect(validateExecutorResult(envelope, fixture.envelope).ok).toBe(true);
    result.attempt_receipt.receipt.claim.version++;
    result.attempt_receipt.receipt_digest = executionDigest(result.attempt_receipt.receipt);
    envelope.result_digest = executionDigest(result);
    expect(validateExecutorResult(envelope, fixture.envelope).ok).toBe(false);
  });
});
