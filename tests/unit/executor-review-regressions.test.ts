import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { executionDigest } from '../../scripts/execution-contract/model.js';
import { canonicalExecutorJson } from '../../scripts/executor-contract/codec.js';
import {
  publishedExecutorSchemas,
  type ExecutorRequest,
  type ExecutorResult,
  type GaapMappingPolicy,
} from '../../scripts/executor-contract/contracts.js';
import { buildGaapRequest, mapGaapResult } from '../../scripts/executor-contract/gaap.js';
import { validateGaapReceipt, validateGaapRequest } from '../../scripts/executor-contract/gaap-validation.js';
import type { GaapEvent, GaapReceipt, GaapRequest } from '../../scripts/executor-contract/gaap-types.js';
import { executorFixture } from '../fixtures/executor-contract.js';
import { operate } from '../fixtures/execution-contract.js';
import { validateExecutorRequest, validateExecutorResult } from '../../scripts/executor-contract/validation.js';

const root = new URL('../../docs/contracts/executor-v0.1/', import.meta.url);
async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(path, root), 'utf8')) as T;
}
function reseal(receipt: GaapReceipt) {
  receipt.body.events.forEach((event, index) => {
    event.sequence = index + 1;
  });
  receipt.receipt_digest = 'sha256:' + executionDigest(receipt.body);
  return receipt;
}
function bytes(receipt: GaapReceipt) {
  const encoded = canonicalExecutorJson(reseal(receipt));
  if (!encoded.ok) throw new Error(JSON.stringify(encoded));
  return Buffer.from(encoded.value);
}
async function mappingFixture(name = 'completed') {
  const fixture = await json<{ request: ExecutorRequest; mapping: GaapMappingPolicy }>('fixtures/local-gates.json');
  const receipt = await json<GaapReceipt>(`fixtures/${name}.gaap.canonical`);
  const scenario = await json<{ observation: unknown }>(`fixtures/${name}.json`);
  return { ...fixture, receipt, ...scenario };
}
async function nativeFixture() {
  return {
    request: await json<GaapRequest>('upstream/gaap/agent-run-request.json'),
    receipt: await json<GaapReceipt>('upstream/gaap/completed.json'),
  };
}

describe('Reproduced executor review boundaries', () => {
  it.each(['null', 'custom', 'subclass'])('rejects %s array prototypes without executing inherited code', (kind) => {
    const array: unknown[] = [1, 2];
    let called = false;
    class ArraySubclass extends Array<unknown> {}
    const prototype =
      kind === 'null'
        ? null
        : kind === 'subclass'
          ? ArraySubclass.prototype
          : (Object.create(Array.prototype) as object);
    if (prototype)
      Object.defineProperty(prototype, 'map', {
        value: () => {
          called = true;
          throw new Error('Inherited map executed');
        },
      });
    Object.setPrototypeOf(array, prototype);
    expect(canonicalExecutorJson(array).ok).toBe(false);
    expect(called).toBe(false);
  });
  it('rejects proxies before invoking object traps', () => {
    let called = false;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          called = true;
          throw new Error('Proxy trap executed');
        },
      },
    );
    expect(canonicalExecutorJson(proxy).ok).toBe(false);
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(canonicalExecutorJson(revoked.proxy).ok).toBe(false);
    expect(called).toBe(false);
  });
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
    'rejects a digest ending in a line separator %j (existing regex behavior)',
    async (suffix) => {
      const { request } = await mappingFixture();
      request.request.mapping_policy.digest += suffix;
      request.request_digest = executionDigest(request.request);
      const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(
        publishedExecutorSchemas()['executor-request']!,
      );
      expect(validate(request)).toBe(false);
      expect(validateExecutorRequest(request).ok).toBe(false);
    },
  );
  it('rejects duplicate mapping families even with different evidence types in schema and mapper', async () => {
    const fixture = await mappingFixture();
    fixture.mapping.policy.evidence_mapping.push({
      ...fixture.mapping.policy.evidence_mapping[0]!,
      evidence_types: ['artifact'],
    });
    fixture.mapping.policy_digest = executionDigest(fixture.mapping.policy);
    fixture.request.request.mapping_policy.digest = fixture.mapping.policy_digest;
    fixture.request.request_digest = executionDigest(fixture.request.request);
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(
      publishedExecutorSchemas()['gaap-mapping-policy']!,
    );
    expect(validate(fixture.mapping)).toBe(false);
    expect(buildGaapRequest(fixture.request, fixture.mapping).ok).toBe(false);
  });
  it.each(['nonterminal', 'approval', 'tool_execution', 'mutation', 'interruption'])(
    'requires semantic checks beyond the immutable upstream schema: %s',
    async (kind) => {
      const { request } = await nativeFixture();
      const receipt = await json<GaapReceipt>(
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
      reseal(receipt);
      const schema = await json<object>('upstream/gaap/terminal-run-receipt.schema.json');
      const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
      expect(validate(receipt)).toBe(true);
      expect(validateGaapReceipt(receipt, request).ok).toBe(false);
    },
  );
  it('rejects duplicate native approval identities', async () => {
    const { request, receipt } = await nativeFixture();
    const approval = receipt.body.events.find((event) => event.event_type === 'approval_recorded');
    if (!approval || approval.event_type !== 'approval_recorded') throw new Error('Missing approval');
    request.approval_context = [approval.approval, structuredClone(approval.approval)];
    expect(validateGaapRequest(request).ok).toBe(false);
  });
  it('requires recorded approvals to target the subject current at that event', async () => {
    const { request, receipt } = await nativeFixture();
    const approval = receipt.body.events.find((event) => event.event_type === 'approval_recorded');
    if (!approval || approval.event_type !== 'approval_recorded') throw new Error('Missing approval');
    const later = structuredClone(approval);
    later.approval.approval_id = 'later_approval';
    later.approval.subject_digest = receipt.body.resulting_subject_digest;
    receipt.body.events.splice(-1, 0, later);
    expect(validateGaapReceipt(reseal(receipt), request).ok).toBe(true);
    later.approval.subject_digest = 'sha256:' + '9'.repeat(64);
    expect(validateGaapReceipt(reseal(receipt), request).ok).toBe(false);
  });
  it('invalidates a passing verification when the same subject later fails verification', async () => {
    const { request, receipt } = await nativeFixture();
    const index = receipt.body.events.findIndex((event) => event.event_type === 'verification');
    const verification = receipt.body.events[index]!;
    if (verification.event_type !== 'verification') throw new Error('Missing verification');
    receipt.body.events.splice(index + 1, 0, { ...structuredClone(verification), verdict: 'FAIL' });
    expect(validateGaapReceipt(reseal(receipt), request).ok).toBe(false);
  });
  it.each(['missing', 'same_actor', 'missing_evidence', 'later_failure', 'source_id', 'source_digest'])(
    'rejects inconsistent direct success evidence: %s',
    async (mutation) => {
      const fixture = await mappingFixture();
      const mapped = mapGaapResult(fixture.request, fixture.mapping, bytes(fixture.receipt), fixture.observation);
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
      envelope.result_digest = executionDigest(result);
      expect(validateExecutorResult(envelope, fixture.request).ok).toBe(false);
    },
  );
  it('retains an unknown-effect changed-subject report solely for recovery', async () => {
    const fixture = await mappingFixture();
    const history = await executorFixture();
    const mapped = mapGaapResult(fixture.request, fixture.mapping, bytes(fixture.receipt), fixture.observation);
    if (!mapped.ok) throw new Error(JSON.stringify(mapped));
    const envelope = mapped.value;
    const receipt = envelope.result.attempt_receipt;
    receipt.receipt.status = 'failed';
    receipt.receipt.effect = 'unknown';
    receipt.receipt.resulting_subject!.content_digest = 'f'.repeat(64);
    envelope.result.reason.code = 'failed';
    receipt.receipt_digest = executionDigest(receipt.receipt);
    envelope.result_digest = executionDigest(envelope.result);
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

  it('rejects identical policy identities with different property insertion order', async () => {
    const { request } = await nativeFixture();
    const policy = request.policies[0]!;
    request.policies.push({ digest: policy.digest, version: policy.version, name: policy.name });
    expect(validateGaapRequest(request).ok).toBe(false);
  });
  it.each(['completed', 'interrupted'])('maps omitted upstream evidence locators in %s receipts', async (name) => {
    const fixture = await mappingFixture(name);
    for (const event of fixture.receipt.body.events) {
      if ('evidence' in event) {
        for (const evidence of Array.isArray(event.evidence) ? event.evidence : [event.evidence])
          Reflect.deleteProperty(evidence, 'locator');
      }
      if (event.event_type === 'approval_recorded') Reflect.deleteProperty(event.approval.evidence, 'locator');
    }
    const result = mapGaapResult(fixture.request, fixture.mapping, bytes(fixture.receipt), fixture.observation);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.value.result.evidence.every((evidence) => evidence.locator === null)).toBe(true);
  });
  it.each(['human', 'policies', 'evidence_types'])(
    'rejects %s in both the published schema and validator',
    async (mutation) => {
      const { request } = await mappingFixture();
      if (mutation === 'human') Reflect.set(request.request.action_request.request, 'actor', 'human');
      if (mutation === 'policies')
        request.request.parameters.policies.push(structuredClone(request.request.parameters.policies[0]!));
      if (mutation === 'evidence_types')
        request.request.parameters.required_verification.evidence_types.push(
          request.request.parameters.required_verification.evidence_types[0]!,
        );
      request.request.action_request.request_digest = executionDigest(request.request.action_request.request);
      request.request_digest = executionDigest(request.request);
      const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(
        publishedExecutorSchemas()['executor-request']!,
      );
      expect(validate(request)).toBe(false);
      expect(validateExecutorRequest(request).ok).toBe(false);
    },
  );
  it('rejects a completed transition that skips verifying (existing route protection)', async () => {
    const { receipt, request } = await nativeFixture();
    receipt.body.events = receipt.body.events.filter(
      (event) => !(event.event_type === 'status_transition' && event.to === 'verifying'),
    );
    const terminal = receipt.body.events.at(-1)!;
    if (terminal.event_type !== 'status_transition') throw new Error('Missing terminal transition');
    terminal.from = 'executing';
    expect(validateGaapReceipt(reseal(receipt), request).ok).toBe(false);
  });
  it('maps the causal denied decision even when a later unrelated allow was recorded', async () => {
    const fixture = await mappingFixture('denied-effect');
    const denied = fixture.receipt.body.events.find((event) => event.event_type === 'protected_effect_decision')!;
    if (denied.event_type !== 'protected_effect_decision') throw new Error('Missing denial');
    fixture.receipt.body.events.splice(-1, 0, {
      ...denied,
      decision_id: 'unrelated_allow',
      decision: { outcome: 'allow', code: 'permission.policy_allowed', effects: [] },
    });
    const result = mapGaapResult(fixture.request, fixture.mapping, bytes(fixture.receipt), fixture.observation);
    expect(result.ok && result.value.result.reason.code).toBe('effect_denied');
  });
  it('rejects an ask that is relabeled as an unrelated terminal cause', async () => {
    const fixture = await mappingFixture('blocked');
    fixture.receipt.body.terminal_reason = 'runtime.hard_stop';
    const terminal = fixture.receipt.body.events.at(-1)!;
    if (terminal.event_type !== 'status_transition') throw new Error('Missing terminal transition');
    terminal.reason = 'runtime.hard_stop';
    expect(mapGaapResult(fixture.request, fixture.mapping, bytes(fixture.receipt), fixture.observation).ok).toBe(false);
  });
  it('rejects a terminal reason that contradicts the final transition', async () => {
    const { receipt, request } = await nativeFixture();
    receipt.body.terminal_reason = 'runtime.hard_stop';
    expect(validateGaapReceipt(reseal(receipt), request).ok).toBe(false);
  });
  it.each(['tool_execution', 'mutation', 'verification'])('rejects %s outside its lifecycle state', async (kind) => {
    const { receipt, request } = await nativeFixture();
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
    expect(validateGaapReceipt(reseal(receipt), request).ok).toBe(false);
  });
  it('preserves native resumability but rejects a resumed ask in the one-shot mapping', async () => {
    const fixture = await mappingFixture();
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
    const native = await json<GaapRequest>('fixtures/gaap-request.json');
    expect(validateGaapReceipt(reseal(fixture.receipt), native).ok).toBe(true);
    expect(mapGaapResult(fixture.request, fixture.mapping, bytes(fixture.receipt), fixture.observation).ok).toBe(false);
  });
  it.each(['occurred_without_mutation', 'none_changed_revision', 'none_changed_digest'])(
    'rejects the result inconsistency %s',
    async (mutation) => {
      const fixture = await mappingFixture();
      const mapped = mapGaapResult(fixture.request, fixture.mapping, bytes(fixture.receipt), fixture.observation);
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
      result.result.attempt_receipt.receipt_digest = executionDigest(receipt);
      result.result_digest = executionDigest(result.result);
      expect(validateExecutorResult(result, fixture.request).ok).toBe(false);
    },
  );
});
