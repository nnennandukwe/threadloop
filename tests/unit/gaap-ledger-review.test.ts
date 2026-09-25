import { describe, expect, it } from 'vitest';
import { digest, type ValidationResult } from '../../scripts/contract-kernel/kernel.js';
import { mapGaapResult } from '../../scripts/executor-contract/gaap.js';
import type { GaapEvent, GaapReceipt, GaapRequest } from '../../scripts/executor-contract/gaap-types.js';
import { validateGaapReceipt } from '../../scripts/executor-contract/gaap-validation.js';
import { executorJson, gaapBytes, gaapMappingFixture, resealGaap } from '../fixtures/executor-contract.js';

/** A published receipt with both the executor inputs and the GAAP request they map to. */
async function fixture(name = 'completed') {
  return { ...(await gaapMappingFixture(name)), native: await executorJson<GaapRequest>('fixtures/gaap-request.json') };
}
function check(value: Awaited<ReturnType<typeof fixture>>) {
  return validateGaapReceipt(resealGaap(value.receipt), value.native);
}
function map(value: Awaited<ReturnType<typeof fixture>>) {
  return mapGaapResult(value.request, value.mapping, gaapBytes(value.receipt), value.observation);
}
/** The first ledger rule a rejected receipt broke. */
function failure(result: ValidationResult<unknown>) {
  return result.ok ? 'accepted' : `${result.diagnostics[0]!.code}: ${result.diagnostics[0]!.message}`;
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
  for (const event of receipt.body.events) if (event.event_type === 'usage') event.usage.tool_calls = count;
}
function budgetToolCalls(value: Awaited<ReturnType<typeof fixture>>, count: number) {
  value.native.resource_budget.max_tool_calls = count;
  value.receipt.body.request_digest = 'sha256:' + digest(value.native);
}

describe('GAAP ledger completion and interruption', () => {
  it.each(['completed', 'blocked', 'failed'])(
    'rejects interruption evidence in a receipt that claims a %s outcome',
    async (outcome) => {
      const value = await fixture(outcome);
      const interrupted = await fixture('interrupted');
      const interruption = interrupted.receipt.body.events.find((event) => event.event_type === 'interruption');
      if (!interruption) throw new Error('Missing interruption event');
      value.receipt.body.events.splice(-1, 0, interruption);
      expect(failure(check(value))).toContain('must terminate as interrupted');
      expect(failure(map(value))).toContain('must terminate as interrupted');
    },
  );

  it('retains an interrupted result with unknown effects as recovery evidence', async () => {
    const value = await fixture('interrupted');
    expect(check(value).ok).toBe(true);
    expect(map(value)).toMatchObject({
      ok: true,
      value: { result: { attempt_receipt: { receipt: { status: 'interrupted', effect: 'unknown' } } } },
    });
  });

  it('maps completion when its protected effect digest differs from its verified subject digest', async () => {
    const value = await fixture();
    completion(value.receipt).protected_effect_digest = 'sha256:' + '5'.repeat(64);
    expect(check(value).ok).toBe(true);
    const result = map(value);
    expect(result.ok && result.value.result.attempt_receipt.receipt.status).toBe('succeeded');
  });

  it.each([
    ['subject', 'bind the current subject'],
    ['ordering', 'later exact-subject completion authorization'],
  ])('retains the completion %s binding with a distinct protected effect', async (kind, reason) => {
    const value = await fixture();
    const decision = completion(value.receipt);
    decision.protected_effect_digest = 'sha256:' + '5'.repeat(64);
    if (kind === 'subject') decision.subject_digest = 'sha256:' + '6'.repeat(64);
    else {
      const events = value.receipt.body.events;
      events.splice(events.indexOf(decision), 1);
      events.splice(
        events.findIndex((event) => event.event_type === 'verification'),
        0,
        decision,
      );
    }
    expect(failure(check(value))).toContain(reason);
  });

  it.each([{ effects: [] }, { effects: ['stop_completion'] }])(
    'rejects completion that does not grant record_completion: $effects',
    async ({ effects }) => {
      const value = await fixture();
      completion(value.receipt).decision.effects = effects;
      expect(failure(check(value))).toContain('must grant the record_completion effect');
      expect(failure(map(value))).toContain('must grant the record_completion effect');
    },
  );

  it('rejects a later inconsistent completion authorization despite an earlier valid grant', async () => {
    const value = await fixture();
    const invalidCompletion = structuredClone(completion(value.receipt));
    invalidCompletion.decision_id = 'completion-without-grant';
    invalidCompletion.decision.effects = [];
    value.receipt.body.events.splice(-1, 0, invalidCompletion);
    expect(failure(check(value))).toContain('must grant the record_completion effect');
  });
});

describe('GAAP ledger tool accounting', () => {
  it('rejects repeated tool executions that underreport cumulative tool usage', async () => {
    const value = await fixture();
    repeatedTool(value.receipt);
    expect(failure(check(value))).toContain('include every tool execution');
    expect(failure(map(value))).toContain('include every tool execution');
  });

  it('rejects underreported intermediate usage even if the final report catches up', async () => {
    const value = await fixture();
    const usage = value.receipt.body.events.find((event) => event.event_type === 'usage');
    if (!usage || usage.event_type !== 'usage') throw new Error('Missing usage');
    const underreported: GaapEvent = { ...structuredClone(usage), usage: { ...usage.usage, tool_calls: 0 } };
    value.receipt.body.events.splice(value.receipt.body.events.indexOf(usage), 0, underreported);
    expect(failure(check(value))).toContain('include every tool execution recorded so far');
  });

  it('rejects final usage that predates an unreported tool execution', async () => {
    const value = await fixture();
    const events = value.receipt.body.events;
    const repeated = repeatedTool(value.receipt);
    events.splice(events.indexOf(repeated), 1);
    events.splice(events.findIndex((event) => event.event_type === 'usage') + 1, 0, repeated);
    expect(failure(check(value))).toContain('Final tool usage must include every recorded tool execution');
  });

  it('rejects a completed receipt whose accurately counted tool calls exceed the budget', async () => {
    const value = await fixture();
    repeatedTool(value.receipt);
    reportToolCalls(value.receipt, 2);
    budgetToolCalls(value, 2);
    expect(check(value).ok).toBe(true);
    budgetToolCalls(value, 1);
    expect(failure(check(value))).toContain('usage within budget');
  });

  it('permits usage to include calls beyond the retained execution events', async () => {
    const value = await fixture();
    reportToolCalls(value.receipt, 2);
    expect(check(value).ok).toBe(true);
  });

  it('retains an accurately reported blocked receipt that exceeded its tool budget', async () => {
    const value = await fixture();
    const { body } = value.receipt;
    repeatedTool(value.receipt);
    reportToolCalls(value.receipt, 2);
    budgetToolCalls(value, 1);
    body.events = body.events.filter((event) => event !== completion(value.receipt));
    const terminal = body.events.at(-1);
    if (!terminal || terminal.event_type !== 'status_transition') throw new Error('Missing terminal transition');
    terminal.to = 'blocked';
    terminal.reason = 'runtime.budget_exhausted';
    body.terminal_status = 'blocked';
    body.terminal_reason = terminal.reason;
    expect(check(value).ok).toBe(true);
  });
});
