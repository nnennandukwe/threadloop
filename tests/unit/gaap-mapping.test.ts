import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { executorFixture } from '../fixtures/executor-contract.js';
import { buildGaapRequest, mapGaapResult } from '../../scripts/executor-contract/gaap.js';
import { canonicalExecutorJson } from '../../scripts/executor-contract/codec.js';
import { digest } from '../../scripts/contract-kernel/kernel.js';
import type { GaapReceipt } from '../../scripts/executor-contract/gaap-types.js';
import { codes } from '../fixtures/contracts.js';

/** An upstream receipt rebound to this fixture's mapped request, subject, and Agent Run identity. */
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
  body.request_digest = 'sha256:' + digest(mapped.value);
  return {
    ...fixture,
    sealed: { body, receipt_digest: 'sha256:' + digest(body) },
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
    for (const [field, code] of [
      ['capability', 'GAAP_MAPPING_MISMATCH'],
      ['policies', 'GAAP_MAPPING_MISMATCH'],
      ['evidence', 'GAAP_EVIDENCE_MAPPING'],
    ] as const) {
      const fixture = await executorFixture();
      if (field === 'capability') fixture.envelope.request.parameters.capability.name = 'unsupported';
      if (field === 'policies') fixture.envelope.request.parameters.policies[0]!.digest = 'f'.repeat(64);
      if (field === 'evidence') fixture.envelope.request.parameters.required_verification.evidence_types = ['artifact'];
      fixture.envelope.request_digest = digest(fixture.envelope.request);
      expect(codes(buildGaapRequest(fixture.envelope, fixture.mapping)), field).toEqual([code]);
    }
  });
  it('maps a replacement Attempt to a distinct Agent Run', async () => {
    const fixture = await executorFixture();
    const first = buildGaapRequest(fixture.envelope, fixture.mapping);
    fixture.envelope.request.claim = { id: 'claim_b', version: 2 };
    fixture.envelope.request.attempt_id = 'attempt_b';
    fixture.envelope.request_digest = digest(fixture.envelope.request);
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
  it('rejects a validly hashed receipt for another request', async () => {
    const fixture = await mappedFixture('completed');
    fixture.sealed.body.request_id = 'another_request';
    fixture.sealed.receipt_digest = 'sha256:' + digest(fixture.sealed.body);
    const canonical = canonicalExecutorJson(fixture.sealed);
    if (!canonical.ok) throw new Error('Invalid fixture');
    const result = mapGaapResult(fixture.envelope, fixture.mapping, Buffer.from(canonical.value), fixture.observation);
    expect(codes(result)).toEqual(['GAAP_REQUEST_MISMATCH']);
  });
});
