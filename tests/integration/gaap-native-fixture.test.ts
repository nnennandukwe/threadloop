import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  buildGaapRequest,
  mapGaapResult,
  parseExecutorMessage,
  validateExecutorRequest,
  type ExecutorResult,
} from 'threadloop-contracts/executor';
import { gaapFixture } from '../fixtures/gaap.js';
import { canonicalGaapJson } from '../../src/domain/gaap-json.js';
import { verifyGaapStatement } from '../../src/domain/gaap-statement.js';
import type { GaapBinding } from '../../src/domain/gaap-binding.js';
import type { ReceiptAdmission } from 'threadloop-contracts/execution';

it.each([
  {
    name: 'threadloop-bound',
    commit: 'a0dca15d479a09c6210d55852e7f20e8dc36da3f',
    terminal: 'completed',
    attempt: 'succeeded',
  },
  {
    name: 'threadloop-bad-patch',
    commit: 'c6f6bb0ec9f3cb532777f6e736f5e66d96764078',
    terminal: 'blocked',
    attempt: 'unknown_outcome',
  },
])('independently verifies real claim-bound Goose $name', async ({ name, commit, terminal, attempt }) => {
  const directory = new URL('../fixtures/gaap/goose-' + name + '/', import.meta.url);
  const fixture = await gaapFixture(name);
  const json = async (name: string): Promise<unknown> =>
    JSON.parse(await readFile(new URL(name, directory), 'utf8')) as unknown;
  const request = validateExecutorRequest(await json('executor-request.json'));
  if (!request.ok) throw new Error(JSON.stringify(request.diagnostics));
  const binding = (await json('binding.json')) as GaapBinding;
  const mapped = buildGaapRequest(request.value, binding.mapping_policy);
  if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
  const provenance = (await json('provenance.json')) as {
    consumer_commit: string;
    consumer_tree_dirty: boolean;
    gaap_commit: string;
    gaap_tree_dirty: boolean;
    implementation_digest: string;
    request_digest: string;
    claim: unknown;
    attempt_id: string;
  };
  expect(provenance.consumer_commit).toBe(commit);
  expect(provenance.gaap_commit).toBe('0a82687d6070081e0a5cb613698f0724dc6f00cb');
  expect(provenance.consumer_tree_dirty || provenance.gaap_tree_dirty).toBe(false);
  expect(provenance.request_digest).toBe(request.value.request_digest);
  expect(provenance.claim).toEqual(request.value.request.claim);
  expect(provenance.attempt_id).toBe(request.value.request.attempt_id);
  expect(fixture.expected).toEqual(mapped.value);
  const verified = await verifyGaapStatement(
    fixture.authenticated,
    mapped.value,
    { read: (digest) => Promise.resolve(fixture.blobs.get(digest)!) },
    { name: 'gaap-governed-goose', version: '0.1.0', digest: provenance.implementation_digest },
  );
  expect(verified.statement.predicate.effects).toHaveLength(3);
  expect(verified.statement.predicate.receipt.body.terminal_status).toBe(terminal);
  const parsed = parseExecutorMessage(await readFile(new URL('executor-result.canonical', directory)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  const result = parsed.value as ExecutorResult;
  const receipt = result.result.attempt_receipt.receipt;
  const remapped = mapGaapResult(
    request.value,
    binding.mapping_policy,
    Buffer.from(canonicalGaapJson(verified.statement.predicate.receipt)),
    { finished_at: receipt.finished_at, resulting_subject: receipt.resulting_subject },
  );
  expect(remapped).toEqual({ ok: true, value: result });
  const admission = (await json('admission.json')) as ReceiptAdmission;
  expect(admission.admission.claim).toEqual(request.value.request.claim);
  expect(admission.admission.attempt_id).toBe(request.value.request.attempt_id);
  expect(admission.admission.receipt.digest).toBe(result.result.attempt_receipt.receipt_digest);
  const inspection = (await json('inspection.json')) as {
    projection: { attempts: Array<{ status: string }> };
    workflow_state: string;
    state_version: number;
    launch_count: number;
    admitted: unknown[];
    evaluations: Array<{ lifecycle_mutated: boolean; candidates: Array<{ available: boolean }> }>;
  };
  expect(inspection).toMatchObject({ workflow_state: 'implementing', state_version: 2, launch_count: 1 });
  expect(inspection.admitted).toHaveLength(1);
  expect(inspection.projection.attempts[0]?.status).toBe(attempt);
  expect(receipt.resulting_subject?.content_digest).not.toBe(
    request.value.request.action_request.request.binding.subject.content_digest,
  );
  expect(inspection.evaluations[0]?.lifecycle_mutated).toBe(false);
  expect(inspection.evaluations[0]?.candidates.every((candidate) => !candidate.available)).toBe(true);
});
