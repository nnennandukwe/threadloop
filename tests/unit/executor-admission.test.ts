import { describe, expect, it } from 'vitest';
import { executorFixture, executorFixtureAuthority } from '../fixtures/executor-contract.js';
import { validateExecutorContext } from '../../scripts/executor-contract/validation.js';
import { executionDigest } from '../../scripts/execution-contract/model.js';
import { operate, target } from '../fixtures/execution-contract.js';
import type { ExecutorRequest } from '../../scripts/executor-contract/contracts.js';

describe('Executor request preflight authority', () => {
  it('requires independent approval of execution parameters as well as started history', async () => {
    const fixture = await executorFixture();
    const journal = fixture.started.journal;
    const snapshot = fixture.context.snapshot;
    const denied = executorFixtureAuthority(journal, snapshot);
    expect(validateExecutorContext(fixture.envelope, journal, snapshot, denied)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'UNTRUSTED_EXECUTOR_REQUEST' }],
    });
    const authority = executorFixtureAuthority(journal, snapshot, fixture.envelope);
    const before = JSON.stringify({ journal, snapshot, request: fixture.envelope });
    expect(validateExecutorContext(fixture.envelope, journal, snapshot, authority).ok).toBe(true);
    expect(JSON.stringify({ journal, snapshot, request: fixture.envelope })).toBe(before);
    fixture.envelope.request.parameters.resource_budget.max_tool_calls++;
    fixture.envelope.request_digest = executionDigest(fixture.envelope.request);
    expect(validateExecutorContext(fixture.envelope, journal, snapshot, authority).ok).toBe(false);
  });
  const mutations: [string, (request: ExecutorRequest['request']) => void][] = [
    [
      'claim generation',
      (request) => {
        request.claim.version++;
      },
    ],
    [
      'claim identity',
      (request) => {
        request.claim.id = 'other';
      },
    ],
    [
      'Attempt',
      (request) => {
        request.attempt_id = 'other';
      },
    ],
    [
      'executor',
      (request) => {
        request.executor.id = 'other';
      },
    ],
    [
      'incarnation',
      (request) => {
        request.executor.incarnation = 'other';
      },
    ],
    [
      'execution policy',
      (request) => {
        request.execution_policy.digest = 'f'.repeat(64);
      },
    ],
    [
      'Workflow Run',
      (request) => {
        request.action_request.request.binding.workflow_run_id = 'other';
      },
    ],
    [
      'graph',
      (request) => {
        request.action_request.request.binding.graph_digest = 'f'.repeat(64);
      },
    ],
    [
      'state version',
      (request) => {
        request.action_request.request.binding.state_version++;
      },
    ],
    [
      'subject',
      (request) => {
        request.action_request.request.binding.subject.content_digest = 'f'.repeat(64);
      },
    ],
    [
      'workflow policy',
      (request) => {
        request.action_request.request.policy.digest = 'f'.repeat(64);
      },
    ],
  ];
  it.each(mutations)('rejects a changed %s despite fresh hashes and approved parameters', async (_name, mutate) => {
    const fixture = await executorFixture();
    mutate(fixture.envelope.request);
    fixture.envelope.request.action_request.request_digest = executionDigest(
      fixture.envelope.request.action_request.request,
    );
    fixture.envelope.request_digest = executionDigest(fixture.envelope.request);
    const authority = executorFixtureAuthority(fixture.started.journal, fixture.context.snapshot, fixture.envelope);
    expect(
      validateExecutorContext(fixture.envelope, fixture.started.journal, fixture.context.snapshot, authority).ok,
    ).toBe(false);
  });
  it('checks current time without mutating or extending the immutable request on renewal', async () => {
    const fixture = await executorFixture();
    const snapshot = fixture.context.snapshot;
    snapshot.evaluation_time = '2026-09-10T10:05:00.000Z';
    let authority = executorFixtureAuthority(fixture.started.journal, snapshot, fixture.envelope);
    expect(validateExecutorContext(fixture.envelope, fixture.started.journal, snapshot, authority).ok).toBe(false);
    const renewed = operate(
      fixture.started.journal,
      { kind: 'renew', ...target, valid_until: '2026-09-10T10:07:00.000Z' },
      undefined,
      '2026-09-10T10:04:00.000Z',
    );
    authority = executorFixtureAuthority(renewed.journal, snapshot, fixture.envelope);
    expect(validateExecutorContext(fixture.envelope, renewed.journal, snapshot, authority).ok).toBe(true);
  });
  it('rejects a current-subject change and never trusts a caller-created authority record', async () => {
    const fixture = await executorFixture();
    const snapshot = fixture.context.snapshot;
    snapshot.binding.state_version++;
    const authority = executorFixtureAuthority(fixture.started.journal, snapshot, fixture.envelope);
    expect(validateExecutorContext(fixture.envelope, fixture.started.journal, snapshot, authority).ok).toBe(false);
    expect(
      validateExecutorContext(fixture.envelope, fixture.started.journal, snapshot, { isAdmitted: () => false }).ok,
    ).toBe(false);
  });
});
