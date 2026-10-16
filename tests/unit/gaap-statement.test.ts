import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { VerifiedGaapEnvelope } from '../../src/adapters/crypto/gaap-dsse.js';
import { canonicalGaapJson } from '../../src/domain/gaap-json.js';
import { gaapObjectDigest } from '../../src/domain/gaap-content.js';
import { verifyGaapStatement } from '../../src/domain/gaap-statement.js';
import { gaapFixture, signGaapTestStatement, signGaapTestPayload } from '../fixtures/gaap.js';

async function verify(fixture: Awaited<ReturnType<typeof gaapFixture>>, resign = false) {
  const authenticated = resign
    ? VerifiedGaapEnvelope.verify(signGaapTestStatement(fixture.statement), fixture.keys)
    : fixture.authenticated;
  return verifyGaapStatement(
    authenticated,
    fixture.expected,
    {
      read(digest) {
        const bytes = fixture.blobs.get(digest);
        if (!bytes) throw new Error('Missing test blob ' + digest);
        return Promise.resolve(bytes);
      },
    },
    fixture.implementation,
  );
}

describe('independent GAAP predicate and retained content', () => {
  it.each(['allow', 'ask', 'bad_patch', 'unreported', 'report_only', 'cancel_before_dispatch'])(
    'verifies original real Goose %s bytes without rewriting identity or status',
    async (name) => {
      const fixture = await gaapFixture(name);
      const verified = await verify(fixture);
      expect(verified.statement.predicate.receipt.body.terminal_status).toBe(
        fixture.statement.predicate.receipt.body.terminal_status,
      );
      expect(verified.blobs.size).toBe(fixture.statement.predicate.blob_digests.length);
      expect(verified.unresolvedReferences.length).toBeGreaterThan(0);
      expect(Buffer.from(canonicalGaapJson(fixture.statement))).toEqual(fixture.authenticated.payload);
    },
  );
  it('pins the upstream predicate schema bytes to merged GAAP #15', async () => {
    const bytes = await readFile(new URL('../../src/contracts/gaap/terminal-run-v1.schema.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'ba983dbd8265b4d1c7d693ba3fe30d15e86b3ccde48a72a7aae7e5a6cb2409bb',
    );
  });
  it.each([
    'predicate_version',
    'contract_version',
    'profile',
    'implementation',
    'request',
    'missing_effect',
    'effect_order',
    'effect_digest',
    'result_digest',
    'unknown_outcome',
    'missing_gate',
    'completion_digest',
  ] as const)('rejects re-signed inconsistent %s', async (kind) => {
    const f = await gaapFixture();
    const p = f.statement.predicate;
    if (kind === 'predicate_version') f.statement.predicateType += '-unknown';
    if (kind === 'contract_version') p.contract_versions[0] = 'unknown';
    if (kind === 'profile') p.snapshot_profile = 'unknown';
    if (kind === 'implementation') p.implementation.digest = 'sha256:' + 'a'.repeat(64);
    if (kind === 'request') p.request.request_id = 'different_request';
    if (kind === 'missing_effect') p.effects.pop();
    if (kind === 'effect_order') p.effects.reverse();
    if (kind === 'effect_digest') p.effects[0]!.request.input_digest = 'sha256:' + 'a'.repeat(64);
    if (kind === 'result_digest') p.effects[0]!.result.result_digest = 'sha256:' + 'a'.repeat(64);
    if (kind === 'unknown_outcome') {
      p.effects[0]!.result.body.execution_status = 'unknown_outcome';
      p.effects[0]!.result.result_digest = gaapObjectDigest(p.effects[0]!.result.body);
    }
    if (kind === 'missing_gate')
      p.receipt.body.events = p.receipt.body.events.filter(
        (event) => event.event_type !== 'protected_effect_decision' || event.gate !== 'runtime',
      );
    if (kind === 'completion_digest')
      for (const event of p.receipt.body.events)
        if (
          event.event_type === 'protected_effect_decision' &&
          event.decision.code === 'workflow.completion_authorized'
        )
          event.protected_effect_digest = 'sha256:' + 'a'.repeat(64);
    p.receipt.body.events.forEach((event, index) => {
      event.sequence = index + 1;
    });
    p.receipt.receipt_digest = gaapObjectDigest(p.receipt.body);
    await expect(verify(f, true)).rejects.toThrow();
  });
  it('rejects stale pre-mutation gate decisions for a later effect even after resealing and re-signing', async () => {
    const f = await gaapFixture();
    const p = f.statement.predicate;
    const second = p.effects[1]!;
    const digest = gaapObjectDigest(second.request);
    const gates = p.receipt.body.events.filter(
      (event) =>
        event.event_type === 'protected_effect_decision' &&
        event.protected_effect_digest === digest &&
        ['runtime', 'tool_trust'].includes(event.gate),
    );
    p.receipt.body.events = p.receipt.body.events.filter((event) => !gates.includes(event));
    for (const gate of gates)
      if (gate.event_type === 'protected_effect_decision') gate.subject_digest = p.request.subject.digest;
    const first = p.receipt.body.events.findIndex((event) => event.event_type === 'tool_execution');
    p.receipt.body.events.splice(first, 0, ...gates);
    p.receipt.body.events.forEach((event, index) => {
      event.sequence = index + 1;
    });
    p.receipt.receipt_digest = gaapObjectDigest(p.receipt.body);
    await expect(verify(f, true)).rejects.toThrow('stale-subject gate');
  });
  it('rejects changed or missing retained bytes and missing snapshot indexes', async () => {
    const changed = await gaapFixture();
    const first = changed.blobs.keys().next().value!;
    changed.blobs.set(first, Buffer.from('changed'));
    await expect(verify(changed)).rejects.toThrow('differ from');
    const missing = await gaapFixture();
    missing.blobs.delete(first);
    await expect(verify(missing)).rejects.toThrow('Missing test blob');
    const index = await gaapFixture();
    index.statement.predicate.snapshot_digests = [index.statement.predicate.request.subject.digest];
    await expect(verify(index, true)).rejects.toThrow('Retain every');
  });
});

it('matches Rust Option defaults before validating contract content identities', async () => {
  const fixture = await gaapFixture();
  const body = fixture.statement.predicate.effects[0]!.result.body;
  Reflect.deleteProperty(body.evidence[0]!, 'locator');
  // Native Rust restores the omitted nullable field before hashing, so its original digest remains valid.
  const accepted = await verify(fixture, true);
  expect(accepted.statement.predicate.effects[0]!.result.body.evidence[0]!.locator).toBe(null);

  const changed = await gaapFixture();
  const effect = changed.statement.predicate.effects[0]!;
  const previousDigest = effect.result.result_digest;
  Reflect.deleteProperty(effect.result.body.evidence[0]!, 'locator');
  effect.result.result_digest = gaapObjectDigest(effect.result.body);
  for (const event of changed.statement.predicate.receipt.body.events)
    if (event.event_type === 'tool_execution')
      for (const reference of event.evidence)
        if (reference.digest === previousDigest) reference.digest = effect.result.result_digest;
  changed.statement.predicate.receipt.receipt_digest = gaapObjectDigest(changed.statement.predicate.receipt.body);
  await expect(verify(changed, true)).rejects.toThrow('body digest');
});

it('accepts signed formatting changes but rejects floating-point literals in integer-only contracts', async () => {
  const fixture = await gaapFixture();
  const pretty = signGaapTestPayload(Buffer.from(JSON.stringify(fixture.statement, null, 2)));
  const reader = {
    read(digest: string) {
      return Promise.resolve(fixture.blobs.get(digest)!);
    },
  };
  await expect(
    verifyGaapStatement(
      VerifiedGaapEnvelope.verify(pretty, fixture.keys),
      fixture.expected,
      reader,
      fixture.implementation,
    ),
  ).resolves.toMatchObject({ statement: { predicate: { receipt: { body: { terminal_status: 'completed' } } } } });
  const floating = signGaapTestPayload(
    Buffer.from(fixture.authenticated.payload.toString().replace('"max_tool_calls":3', '"max_tool_calls":3.0')),
  );
  await expect(
    verifyGaapStatement(
      VerifiedGaapEnvelope.verify(floating, fixture.keys),
      fixture.expected,
      reader,
      fixture.implementation,
    ),
  ).rejects.toThrow();
});
