import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { executorFixture } from '../fixtures/executor-contract.js';
import { buildGaapRequest, mapGaapResult } from '../../scripts/executor-contract/gaap.js';
import { canonicalExecutorJson } from '../../scripts/executor-contract/codec.js';
import { executionDigest } from '../../scripts/execution-contract/model.js';
import type { GaapReceipt } from '../../scripts/executor-contract/gaap-types.js';

async function mappedFixture(name: string) {
  const fixture = await executorFixture();
  const mapped = buildGaapRequest(fixture.envelope, fixture.mapping);
  if (!mapped.ok) throw new Error(JSON.stringify(mapped));
  const receipt = JSON.parse(
    await readFile(new URL(`../../docs/contracts/executor-v0.1/upstream/gaap/${name}.json`, import.meta.url), 'utf8'),
  ) as GaapReceipt;
  const source = receipt.body.initial_subject_digest;
  const subject = mapped.value.subject.digest;
  const body = JSON.parse(JSON.stringify(receipt.body).replaceAll(source, subject)) as GaapReceipt['body'];
  body.request_id = mapped.value.request_id;
  body.run_id = mapped.value.run_id;
  body.request_digest = 'sha256:' + executionDigest(mapped.value);
  const sealed = { body, receipt_digest: 'sha256:' + executionDigest(body) };
  const canonical = canonicalExecutorJson(sealed);
  if (!canonical.ok) throw new Error(JSON.stringify(canonical));
  return {
    ...fixture,
    mapped: mapped.value,
    sealed,
    bytes: Buffer.from(canonical.value),
    observation: {
      finished_at: '2026-09-10T10:01:00.000Z',
      resulting_subject: {
        ...fixture.envelope.request.action_request.request.binding.subject,
        content_digest: body.resulting_subject_digest.slice(7),
      },
    },
  };
}

describe('GAAP mapping candidates', () => {
  it('requires explicit supported capability, policy, and evidence mappings', async () => {
    for (const field of ['capability', 'policies', 'evidence'] as const) {
      const fixture = await executorFixture();
      if (field === 'capability') fixture.envelope.request.parameters.capability.name = 'unsupported';
      if (field === 'policies') fixture.envelope.request.parameters.policies[0]!.digest = 'f'.repeat(64);
      if (field === 'evidence') fixture.envelope.request.parameters.required_verification.evidence_types = ['artifact'];
      fixture.envelope.request_digest = executionDigest(fixture.envelope.request);
      expect(buildGaapRequest(fixture.envelope, fixture.mapping).ok).toBe(false);
    }
  });
  it('maps a replacement Attempt to a distinct Agent Run', async () => {
    const fixture = await executorFixture();
    const first = buildGaapRequest(fixture.envelope, fixture.mapping);
    fixture.envelope.request.claim = { id: 'claim_b', version: 2 };
    fixture.envelope.request.attempt_id = 'attempt_b';
    fixture.envelope.request_digest = executionDigest(fixture.envelope.request);
    const next = buildGaapRequest(fixture.envelope, fixture.mapping);
    expect(first.ok && next.ok && first.value.run_id !== next.value.run_id).toBe(true);
  });
  it('maps explicit parameters without introducing ThreadLoop lifecycle fields', async () => {
    const fixture = await executorFixture();
    const mapped = buildGaapRequest(fixture.envelope, fixture.mapping);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value.subject.digest).toBe('sha256:' + fixture.request.request.binding.subject.content_digest);
    expect(mapped.value.approval_context).toEqual([]);
    expect(mapped.value).not.toHaveProperty('claim');
    expect(buildGaapRequest(fixture.envelope, fixture.mapping)).toEqual(mapped);
  });
  it.each([
    ['completed', 'succeeded', 'completed'],
    ['blocked', 'blocked', 'authority_required'],
    ['denied-effect', 'blocked', 'effect_denied'],
    ['failed', 'failed', 'failed'],
    ['interrupted', 'interrupted', 'interrupted'],
    ['budget-exhausted', 'blocked', 'budget_exhausted'],
  ])('preserves %s status and reason', async (name, status, reason) => {
    const fixture = await mappedFixture(name);
    const result = mapGaapResult(fixture.envelope, fixture.mapping, fixture.bytes, fixture.observation);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.result.attempt_receipt.receipt.status).toBe(status);
    expect(result.value.result.reason.code).toBe(reason);
    expect(result.value).not.toHaveProperty('admission');
    if (status !== 'succeeded') expect(result.value.result.attempt_receipt.receipt.effect).toBe('unknown');
  });
  it('rejects a validly hashed receipt for another request', async () => {
    const fixture = await mappedFixture('completed');
    fixture.sealed.body.request_id = 'another_request';
    fixture.sealed.receipt_digest = 'sha256:' + executionDigest(fixture.sealed.body);
    const canonical = canonicalExecutorJson(fixture.sealed);
    if (!canonical.ok) throw new Error('Invalid fixture');
    expect(mapGaapResult(fixture.envelope, fixture.mapping, Buffer.from(canonical.value), fixture.observation).ok).toBe(
      false,
    );
  });
});
