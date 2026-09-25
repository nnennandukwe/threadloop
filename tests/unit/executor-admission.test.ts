import { describe, expect, it } from 'vitest';
import { executorFixture, executorFixtureAuthority } from '../fixtures/executor-contract.js';
import { validateExecutorContext } from '../../scripts/executor-contract/validation.js';
import { digest } from '../../scripts/contract-kernel/kernel.js';
import { requestIdentity } from '../../scripts/controller-contract/validation.js';
import { operate, target } from '../fixtures/execution-contract.js';
import type { ExecutorRequest } from '../../scripts/executor-contract/contracts.js';
import { codes } from '../fixtures/contracts.js';

describe('Executor request preflight authority', () => {
  it('requires independent approval of execution parameters as well as started history', async () => {
    const fixture = await executorFixture();
    const journal = fixture.started.journal;
    const snapshot = fixture.context.snapshot;
    const denied = executorFixtureAuthority(journal, snapshot);
    expect(codes(validateExecutorContext(fixture.envelope, journal, snapshot, denied))).toEqual([
      'UNTRUSTED_EXECUTOR_REQUEST',
    ]);
    const authority = executorFixtureAuthority(journal, snapshot, fixture.envelope);
    const before = JSON.stringify({ journal, snapshot, request: fixture.envelope });
    expect(validateExecutorContext(fixture.envelope, journal, snapshot, authority).ok).toBe(true);
    expect(JSON.stringify({ journal, snapshot, request: fixture.envelope })).toBe(before);
    fixture.envelope.request.parameters.resource_budget.max_tool_calls++;
    fixture.envelope.request_digest = digest(fixture.envelope.request);
    expect(codes(validateExecutorContext(fixture.envelope, journal, snapshot, authority))).toEqual([
      'UNTRUSTED_EXECUTOR_REQUEST',
    ]);
  });

  const mutations: [string, (request: ExecutorRequest['request']) => void][] = [
    ['claim generation', (request) => void request.claim.version++],
    ['claim identity', (request) => void (request.claim.id = 'other')],
    ['Attempt', (request) => void (request.attempt_id = 'other')],
    ['executor', (request) => void (request.executor.id = 'other')],
    ['incarnation', (request) => void (request.executor.incarnation = 'other')],
    ['execution policy', (request) => void (request.execution_policy.digest = 'f'.repeat(64))],
    ['Workflow Run', (request) => void (request.action_request.request.binding.workflow_run_id = 'other')],
    ['graph', (request) => void (request.action_request.request.binding.graph_digest = 'f'.repeat(64))],
    ['state version', (request) => void request.action_request.request.binding.state_version++],
    ['subject', (request) => void (request.action_request.request.binding.subject.content_digest = 'f'.repeat(64))],
    ['workflow policy', (request) => void (request.action_request.request.policy.digest = 'f'.repeat(64))],
  ];
  it.each(mutations)('rejects a changed %s despite fresh hashes and approved parameters', async (_name, mutate) => {
    const fixture = await executorFixture();
    const request = fixture.envelope.request;
    mutate(request);
    // Reseal every identity, so only the context comparison can reject the request.
    const action = request.action_request.request;
    action.idempotency_key = requestIdentity(action.binding, action.action_id);
    request.action_request.request_digest = digest(action);
    fixture.envelope.request_digest = digest(request);
    const authority = executorFixtureAuthority(fixture.started.journal, fixture.context.snapshot, fixture.envelope);
    const result = validateExecutorContext(
      fixture.envelope,
      fixture.started.journal,
      fixture.context.snapshot,
      authority,
    );
    expect(codes(result)).toEqual(['EXECUTOR_CONTEXT_MISMATCH']);
  });

  it('checks current time without mutating or extending the immutable request on renewal', async () => {
    const fixture = await executorFixture();
    const requestBefore = JSON.stringify(fixture.envelope);
    const snapshot = fixture.context.snapshot;
    snapshot.evaluation_time = '2026-09-10T10:05:00.000Z';
    let authority = executorFixtureAuthority(fixture.started.journal, snapshot, fixture.envelope);
    expect(codes(validateExecutorContext(fixture.envelope, fixture.started.journal, snapshot, authority))).toEqual([
      'EXECUTOR_CONTEXT_MISMATCH',
    ]);
    expect(JSON.stringify(fixture.envelope)).toBe(requestBefore);
    const renewed = operate(
      fixture.started.journal,
      { kind: 'renew', ...target, valid_until: '2026-09-10T10:07:00.000Z' },
      undefined,
      '2026-09-10T10:04:00.000Z',
    );
    authority = executorFixtureAuthority(renewed.journal, snapshot, fixture.envelope);
    expect(validateExecutorContext(fixture.envelope, renewed.journal, snapshot, authority).ok).toBe(true);
    expect(JSON.stringify(fixture.envelope)).toBe(requestBefore);
  });

  it('rejects a current-subject change despite independently admitted request parameters', async () => {
    const fixture = await executorFixture();
    const snapshot = fixture.context.snapshot;
    snapshot.binding.state_version++;
    const authority = executorFixtureAuthority(fixture.started.journal, snapshot, fixture.envelope);
    expect(codes(validateExecutorContext(fixture.envelope, fixture.started.journal, snapshot, authority))).toEqual([
      'EXECUTOR_CONTEXT_MISMATCH',
    ]);
  });
});
