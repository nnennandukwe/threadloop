import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { executionDigest } from '../../scripts/execution-contract/model.js';
import {
  publishedExecutorSchemas,
  type ExecutorRequest,
  type GaapMappingPolicy,
} from '../../scripts/executor-contract/contracts.js';
import { mapGaapResult } from '../../scripts/executor-contract/gaap.js';
import { validateExecutorRequest, validateExecutorResult } from '../../scripts/executor-contract/validation.js';
import { executorFixture } from '../fixtures/executor-contract.js';

const root = new URL('../../docs/contracts/executor-v0.1/fixtures/', import.meta.url);
const requestSchema = new Ajv2020({ strict: true, validateFormats: false }).compile(
  publishedExecutorSchemas()['executor-request']!,
);

describe('Executor PR review regressions', () => {
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
    const blank = ' \t\n\u2003';
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
    envelope.request_digest = executionDigest(envelope.request);
    const before = structuredClone(envelope);
    expect(requestSchema(envelope)).toBe(false);
    const result = validateExecutorRequest(envelope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.path).toContain('parameters');
    expect(envelope).toEqual(before);
  });

  it('preserves meaningful task whitespace and its digest', async () => {
    const { envelope } = await executorFixture();
    envelope.request.parameters.task.instructions = '  Run gates.\n';
    envelope.request_digest = executionDigest(envelope.request);
    expect(requestSchema(envelope)).toBe(true);
    const result = validateExecutorRequest(envelope);
    expect(result.ok && result.value).toEqual(envelope);
  });

  it.each(['same_digest', 'different_digest'])('rejects duplicate Attempt evidence IDs with %s', async (kind) => {
    const fixture = JSON.parse(await readFile(new URL('local-gates.json', root), 'utf8')) as {
      request: ExecutorRequest;
      mapping: GaapMappingPolicy;
    };
    const scenario = JSON.parse(await readFile(new URL('completed.json', root), 'utf8')) as { observation: unknown };
    const mapped = mapGaapResult(
      fixture.request,
      fixture.mapping,
      await readFile(new URL('completed.gaap.canonical', root)),
      scenario.observation,
    );
    if (!mapped.ok) throw new Error(JSON.stringify(mapped));
    const result = mapped.value;
    const receipt = result.result.attempt_receipt;
    const original = receipt.receipt.evidence[0]!;
    receipt.receipt.evidence.push({ ...original, digest: kind === 'same_digest' ? original.digest : 'f'.repeat(64) });
    receipt.receipt_digest = executionDigest(receipt.receipt);
    result.result_digest = executionDigest(result.result);
    const before = structuredClone(result);
    const checked = validateExecutorResult(result, fixture.request);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.diagnostics[0]?.code).toBe('DUPLICATE_RESULT_EVIDENCE');
    expect(result).toEqual(before);
  });
});
