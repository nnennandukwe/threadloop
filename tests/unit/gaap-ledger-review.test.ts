import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { executionDigest } from '../../scripts/execution-contract/model.js';
import { canonicalExecutorJson } from '../../scripts/executor-contract/codec.js';
import type { ExecutorRequest, GaapMappingPolicy } from '../../scripts/executor-contract/contracts.js';
import { mapGaapResult } from '../../scripts/executor-contract/gaap.js';
import type { GaapEvent, GaapReceipt, GaapRequest } from '../../scripts/executor-contract/gaap-types.js';
import { validateGaapReceipt } from '../../scripts/executor-contract/gaap-validation.js';

const root = new URL('../../docs/contracts/executor-v0.1/fixtures/', import.meta.url);
async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(path, root), 'utf8')) as T;
}
async function fixture(name = 'completed') {
  const inputs = await json<{ request: ExecutorRequest; mapping: GaapMappingPolicy }>('local-gates.json');
  const receipt = await json<GaapReceipt>(`${name}.gaap.canonical`);
  const request = await json<GaapRequest>('gaap-request.json');
  const { observation } = await json<{ observation: unknown }>(`${name}.json`);
  return { inputs, receipt, request, observation };
}
function seal(receipt: GaapReceipt) {
  receipt.body.events.forEach((event, index) => {
    event.sequence = index + 1;
  });
  receipt.receipt_digest = 'sha256:' + executionDigest(receipt.body);
  return receipt;
}
function completion(receipt: GaapReceipt) {
  const event = receipt.body.events.find(
    (entry) =>
      entry.event_type === 'protected_effect_decision' && entry.decision.code === 'workflow.completion_authorized',
  );
  if (!event || event.event_type !== 'protected_effect_decision') throw new Error('Missing completion decision');
  return event;
}
function repeatedTool(receipt: GaapReceipt) {
  const tool = receipt.body.events.find((event) => event.event_type === 'tool_execution');
  if (!tool || tool.event_type !== 'tool_execution') throw new Error('Missing tool execution');
  const repeated = structuredClone(tool);
  receipt.body.events.splice(receipt.body.events.indexOf(tool) + 1, 0, repeated);
  return repeated;
}
function reportToolCalls(receipt: GaapReceipt, count: number) {
  receipt.body.usage.tool_calls = count;
  for (const event of receipt.body.events) {
    if (event.event_type === 'usage') event.usage.tool_calls = count;
  }
}
function budgetToolCalls(receipt: GaapReceipt, request: GaapRequest, count: number) {
  request.resource_budget.max_tool_calls = count;
  receipt.body.request_digest = 'sha256:' + executionDigest(request);
}
function map(fixtureValue: Awaited<ReturnType<typeof fixture>>) {
  const encoded = canonicalExecutorJson(seal(fixtureValue.receipt));
  if (!encoded.ok) throw new Error(JSON.stringify(encoded));
  return mapGaapResult(
    fixtureValue.inputs.request,
    fixtureValue.inputs.mapping,
    Buffer.from(encoded.value),
    fixtureValue.observation,
  );
}

describe('GAAP ledger review regressions', () => {
  it.each(['completed', 'blocked', 'failed'])(
    'rejects interruption evidence in a receipt that claims a %s outcome',
    async (outcome) => {
      const value = await fixture(outcome);
      const interrupted = await fixture('interrupted');
      const interruption = interrupted.receipt.body.events.find((event) => event.event_type === 'interruption');
      if (!interruption) throw new Error('Missing interruption event');
      value.receipt.body.events.splice(-1, 0, interruption);
      const checked = validateGaapReceipt(seal(value.receipt), value.request);
      expect(checked).toMatchObject({
        ok: false,
        diagnostics: [{ code: 'GAAP_LEDGER_INVALID' }],
      });
      if (!checked.ok) expect(checked.diagnostics[0]?.message).toContain('interrupted');
      expect(map(value).ok).toBe(false);
    },
  );

  it('retains an interrupted result with unknown effects as recovery evidence', async () => {
    const value = await fixture('interrupted');
    expect(validateGaapReceipt(value.receipt, value.request).ok).toBe(true);
    expect(map(value)).toMatchObject({
      ok: true,
      value: { result: { attempt_receipt: { receipt: { status: 'interrupted', effect: 'unknown' } } } },
    });
  });

  it('maps completion when its protected effect digest differs from its verified subject digest', async () => {
    const value = await fixture();
    completion(value.receipt).protected_effect_digest = 'sha256:' + '5'.repeat(64);
    expect(validateGaapReceipt(seal(value.receipt), value.request).ok).toBe(true);
    const result = map(value);
    expect(result.ok && result.value.result.attempt_receipt.receipt.status).toBe('succeeded');
  });

  it.each(['subject', 'ordering'])(
    'retains the completion %s binding with a distinct protected effect',
    async (kind) => {
      const { receipt, request } = await fixture();
      const decision = completion(receipt);
      decision.protected_effect_digest = 'sha256:' + '5'.repeat(64);
      if (kind === 'subject') decision.subject_digest = 'sha256:' + '6'.repeat(64);
      else {
        receipt.body.events.splice(receipt.body.events.indexOf(decision), 1);
        const verification = receipt.body.events.findIndex((event) => event.event_type === 'verification');
        receipt.body.events.splice(verification, 0, decision);
      }
      expect(validateGaapReceipt(seal(receipt), request).ok).toBe(false);
    },
  );

  it.each([{ effects: [] }, { effects: ['stop_completion'] }])(
    'rejects completion that does not grant record_completion: $effects',
    async ({ effects }) => {
      const value = await fixture();
      completion(value.receipt).decision.effects = effects;
      expect(validateGaapReceipt(seal(value.receipt), value.request).ok).toBe(false);
      expect(map(value).ok).toBe(false);
    },
  );

  it('rejects a later inconsistent completion authorization despite an earlier valid grant', async () => {
    const { receipt, request } = await fixture();
    const invalidCompletion = structuredClone(completion(receipt));
    invalidCompletion.decision_id = 'completion-without-grant';
    invalidCompletion.decision.effects = [];
    receipt.body.events.splice(-1, 0, invalidCompletion);
    expect(validateGaapReceipt(seal(receipt), request).ok).toBe(false);
  });

  it('rejects repeated tool executions that underreport cumulative tool usage', async () => {
    const value = await fixture();
    repeatedTool(value.receipt);
    expect(validateGaapReceipt(seal(value.receipt), value.request).ok).toBe(false);
    expect(map(value).ok).toBe(false);
  });

  it('rejects underreported intermediate usage even if the final report catches up', async () => {
    const { receipt, request } = await fixture();
    const usage = receipt.body.events.find((event) => event.event_type === 'usage');
    if (!usage || usage.event_type !== 'usage') throw new Error('Missing usage');
    const underreported: GaapEvent = { ...structuredClone(usage), usage: { ...usage.usage, tool_calls: 0 } };
    receipt.body.events.splice(receipt.body.events.indexOf(usage), 0, underreported);
    expect(validateGaapReceipt(seal(receipt), request).ok).toBe(false);
  });

  it('rejects final usage that predates an unreported tool execution', async () => {
    const { receipt, request } = await fixture();
    const repeated = repeatedTool(receipt);
    receipt.body.events.splice(receipt.body.events.indexOf(repeated), 1);
    const usage = receipt.body.events.findIndex((event) => event.event_type === 'usage');
    receipt.body.events.splice(usage + 1, 0, repeated);
    expect(validateGaapReceipt(seal(receipt), request).ok).toBe(false);
  });

  it('rejects observed tool calls above budget even when reported usage stays within budget', async () => {
    const { receipt, request } = await fixture();
    repeatedTool(receipt);
    budgetToolCalls(receipt, request, 1);
    expect(validateGaapReceipt(seal(receipt), request).ok).toBe(false);
  });

  it('accepts counted tool executions with a reused matching authorization and sufficient budget', async () => {
    const { receipt, request } = await fixture();
    repeatedTool(receipt);
    reportToolCalls(receipt, 2);
    expect(validateGaapReceipt(seal(receipt), request).ok).toBe(true);
  });

  it('permits usage to include calls beyond the retained execution events', async () => {
    const { receipt, request } = await fixture();
    reportToolCalls(receipt, 2);
    expect(validateGaapReceipt(seal(receipt), request).ok).toBe(true);
  });

  it('retains an accurately reported blocked receipt that exceeded its tool budget', async () => {
    const { receipt, request } = await fixture();
    repeatedTool(receipt);
    reportToolCalls(receipt, 2);
    budgetToolCalls(receipt, request, 1);
    receipt.body.events = receipt.body.events.filter((event) => event !== completion(receipt));
    const terminal = receipt.body.events.at(-1);
    if (!terminal || terminal.event_type !== 'status_transition') throw new Error('Missing terminal transition');
    terminal.to = 'blocked';
    terminal.reason = 'runtime.budget_exhausted';
    receipt.body.terminal_status = 'blocked';
    receipt.body.terminal_reason = terminal.reason;
    expect(validateGaapReceipt(seal(receipt), request).ok).toBe(true);
  });
});
