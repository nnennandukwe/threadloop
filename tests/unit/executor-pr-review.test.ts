import { describe, expect, it } from 'vitest';
import { digest } from '../../scripts/contract-kernel/kernel.js';
import { publishedExecutorSchemas } from '../../scripts/executor-contract/contracts.js';
import { mapGaapResult } from '../../scripts/executor-contract/gaap.js';
import { validateExecutorRequest, validateExecutorResult } from '../../scripts/executor-contract/validation.js';
import { executorFixture, gaapBytes, gaapMappingFixture } from '../fixtures/executor-contract.js';
import { ajv, codes } from '../fixtures/contracts.js';

const requestSchema = ajv().compile(publishedExecutorSchemas()['executor-request']!);

async function mappedCompletion() {
  const fixture = await gaapMappingFixture();
  const mapped = mapGaapResult(fixture.request, fixture.mapping, gaapBytes(fixture.receipt), fixture.observation);
  if (!mapped.ok) throw new Error(JSON.stringify(mapped));
  return { request: fixture.request, envelope: mapped.value };
}

describe('Executor text and evidence identity', () => {
  it.each([
    'subject_locator',
    'instructions',
    'constraints',
    'capability_name',
    'capability_version',
    'policy_name',
    'policy_version',
    'approval_id',
    'actor_id',
    'scope',
    'approval_locator',
  ])('rejects whitespace-only %s before mapping, without normalizing it', async (field) => {
    const { envelope } = await executorFixture();
    const parameters = envelope.request.parameters;
    const blank = ' \t\n ';
    parameters.approval_context = [
      {
        approval_id: 'approval',
        actor_id: 'reviewer',
        scope: 'run local gates',
        subject_digest: envelope.request.action_request.request.binding.subject.content_digest,
        evidence: { evidence_type: 'approval', digest: 'a'.repeat(64), locator: 'receipt://approval' },
      },
    ];
    if (field === 'subject_locator') parameters.subject_locator = blank;
    if (field === 'instructions') parameters.task.instructions = blank;
    if (field === 'constraints') parameters.task.constraints = [blank];
    if (field === 'capability_name') parameters.capability.name = blank;
    if (field === 'capability_version') parameters.capability.version = blank;
    if (field === 'policy_name') parameters.policies[0]!.name = blank;
    if (field === 'policy_version') parameters.policies[0]!.version = blank;
    if (field === 'approval_id') parameters.approval_context[0]!.approval_id = blank;
    if (field === 'actor_id') parameters.approval_context[0]!.actor_id = blank;
    if (field === 'scope') parameters.approval_context[0]!.scope = blank;
    if (field === 'approval_locator') parameters.approval_context[0]!.evidence.locator = blank;
    envelope.request_digest = digest(envelope.request);
    const before = structuredClone(envelope);
    expect(requestSchema(envelope)).toBe(false);
    const result = validateExecutorRequest(envelope);
    expect(codes(result)).toEqual(['SCHEMA_INVALID']);
    expect(result.ok || result.diagnostics[0]?.path).toContain('parameters');
    expect(envelope).toEqual(before);
  });

  it('preserves meaningful task whitespace and its digest', async () => {
    const { envelope } = await executorFixture();
    envelope.request.parameters.task.instructions = '  Run gates.\n';
    envelope.request_digest = digest(envelope.request);
    expect(requestSchema(envelope)).toBe(true);
    const result = validateExecutorRequest(envelope);
    expect(result.ok && result.value).toEqual(envelope);
  });

  it.each(['same_digest', 'different_digest'])('rejects duplicate Attempt evidence IDs with %s', async (kind) => {
    const { request, envelope } = await mappedCompletion();
    const receipt = envelope.result.attempt_receipt;
    const original = receipt.receipt.evidence[0]!;
    receipt.receipt.evidence.push({ ...original, digest: kind === 'same_digest' ? original.digest : 'f'.repeat(64) });
    receipt.receipt_digest = digest(receipt.receipt);
    envelope.result_digest = digest(envelope.result);
    const before = structuredClone(envelope);
    expect(codes(validateExecutorResult(envelope, request))).toEqual(['DUPLICATE_RESULT_EVIDENCE']);
    expect(envelope).toEqual(before);
  });

  it.each(['supporting', 'effect', 'verification'])(
    'requires reported %s evidence to survive in the submitted Attempt receipt',
    async (kind) => {
      const { request, envelope } = await mappedCompletion();
      const result = envelope.result;
      const receipt = result.attempt_receipt;
      const proof = { evidence_type: 'artifact' as const, digest: '9'.repeat(64), locator: null };
      if (kind === 'supporting') result.evidence.push(proof);
      if (kind === 'verification') result.verification[0]!.evidence.push(proof);
      if (kind === 'effect') {
        receipt.receipt.effect = 'occurred';
        const subject = receipt.receipt.binding.subject.content_digest;
        result.effects.push({
          effect_digest: '8'.repeat(64),
          before_subject_digest: subject,
          after_subject_digest: subject,
          evidence: [proof],
        });
      }
      receipt.receipt.evidence.push({ id: 'retained_proof', digest: proof.digest });
      receipt.receipt_digest = digest(receipt.receipt);
      envelope.result_digest = digest(result);
      expect(validateExecutorResult(envelope, request).ok).toBe(true);
      receipt.receipt.evidence = receipt.receipt.evidence.filter((entry) => entry.digest !== proof.digest);
      receipt.receipt_digest = digest(receipt.receipt);
      envelope.result_digest = digest(result);
      const before = structuredClone(envelope);
      expect(codes(validateExecutorResult(envelope, request))).toEqual(['RESULT_EVIDENCE_MISMATCH']);
      expect(envelope).toEqual(before);
    },
  );
});
