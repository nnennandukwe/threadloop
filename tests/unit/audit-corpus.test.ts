import { expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { createAuditEvent, ZERO_AUDIT_HASH } from '../../src/domain/audit.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import type { AuditEventType, StoredAuditEvent } from '../../src/domain/audit.js';
import type { TaskStatus } from '../../src/domain/types.js';
import type { RunConfiguration } from '../../src/domain/run-configuration.js';
import { createAuditCorpus, verifyAuditCorpus } from '../../src/domain/audit-corpus.js';

const descriptor: RunConfiguration = {
  schema_version: 'threadloop.run-configuration/1',
  threadloop_version: 'fixture',
  implementation_sha256: '1'.repeat(64),
  implementation_scope: 'javascript_bundle',
  storage_schema_version: 8,
  protocol_components: {
    protocol: 4,
    proofPlan: 4,
    sessionNext: 4,
    signedReviewReceipt: 1,
    auditEvent: 1,
    handoff: 3,
  },
  caller: { harness: 'fixture', model: null },
  proof_plan_sha256: '2'.repeat(64),
  runner_skill_sha256: '3'.repeat(64),
};

function appendEvent(
  events: StoredAuditEvent[],
  sessionId: string,
  eventType: AuditEventType,
  stateVersion: number,
  payload: Record<string, unknown>,
) {
  events.push(
    createAuditEvent(
      {
        id: `e-${events.length}`,
        sessionId,
        sequence: events.length + 1,
        eventType,
        recordedAt: new Date(Date.UTC(2026, 10, 14, 17, 0, events.length)).toISOString(),
        stateVersion,
        previousSha256: events.at(-1)?.sha256 ?? ZERO_AUDIT_HASH,
        payload,
      },
      sha256,
    ),
  );
}

function session(sessionId = 'legacy') {
  return {
    session_id: sessionId,
    events: [
      createAuditEvent(
        {
          id: `audit-${sessionId}`,
          sessionId,
          sequence: 1,
          eventType: 'session_started',
          recordedAt: '2026-11-14T17:00:00.000Z',
          stateVersion: 0,
          previousSha256: ZERO_AUDIT_HASH,
          payload: { task_id: 'task-1', lifecycle_state: 'queued' },
        },
        sha256,
      ),
    ],
  };
}

it('emits a deterministic per-session corpus and verifies it independently with a retained root', () => {
  const built = createAuditCorpus([session('b'), session('a')], sha256);
  expect(createAuditCorpus([session('a'), session('b')], sha256)).toEqual(built);
  expect(verifyAuditCorpus(built.content, sha256, built.root)).toMatchObject({
    valid: true,
    root: built.root,
    session_count: 2,
    event_count: 2,
    manifest: {
      comparison_unit: 'session',
      sessions: expect.arrayContaining([
        expect.objectContaining({
          session_id: 'a',
          attribution: 'legacy_unattributable',
          run_configuration: null,
          outcome: expect.objectContaining({
            state: 'queued',
            terminal: false,
            wake_count: null,
            stop_only_handoff_count: null,
          }) as unknown,
        }),
      ]) as unknown,
    },
  });
});

it.each([
  (s: string) => s.split('\n').slice(0, -2).join('\n') + '\n',
  (s: string) => s.replace('queued', 'completed'),
  (s: string) => s.replace('"session_count":1', '"session_count":2'),
  (s: string) => s.replace('threadloop.audit-corpus/1', 'threadloop.audit-corpus/2'),
  (s: string) => s.replace('"wake_count":null', '"wake_count":0'),
  (s: string) => s + '{}\n',
  (s: string) => s.slice(0, -1),
])('rejects changed, truncated, extended, and unsupported corpus bytes', (mutate) => {
  const built = createAuditCorpus([session()], sha256);
  expect(() => verifyAuditCorpus(mutate(built.content), sha256)).toThrow();
});

it('rejects dropped sessions, duplicated membership, foreign events, and wrong retained roots', () => {
  expect(() => createAuditCorpus([session(), session()], sha256)).toThrow();
  const foreign = session();
  foreign.session_id = 'other';
  expect(() => createAuditCorpus([foreign], sha256)).toThrow();
  const built = createAuditCorpus([session()], sha256);
  expect(() => verifyAuditCorpus(built.content, sha256, 'f'.repeat(64))).toThrow();
});

it.each(['matched', 'mismatched', 'unbound'] as const)(
  'projects observed outcomes and a %s declared proof binding',
  (binding) => {
    const events: StoredAuditEvent[] = [];
    let version = 0;
    function append(type: AuditEventType, payload: Record<string, unknown>) {
      appendEvent(events, 'outcome', type, version, payload);
    }
    append('session_started', { task_id: 't', lifecycle_state: 'queued', run_configuration: descriptor });
    let state = 'queued';
    for (const target of [
      'framed',
      'proof_ready',
      'implementing',
      'verifying',
      'implementing',
      'verifying',
      'pre_pr_reviewing',
      'reviewing',
      'repairing',
      'verifying',
      'reviewing',
      'ready_for_human',
      'completed',
    ]) {
      const fromVersion = version++;
      append('transition_applied', {
        from_state: state,
        to_state: target,
        from_state_version: fromVersion,
        to_state_version: version,
        ...(target === 'proof_ready' && binding !== 'unbound'
          ? { proof_plan_sha256: (binding === 'matched' ? '2' : '4').repeat(64) }
          : {}),
      });
      state = target;
      if (target === 'verifying') {
        append('proof_receipt_recorded', { result: 'setup_failed', gate_id: 'check' });
        append('proof_receipt_recorded', { result: 'failed', gate_id: 'check' });
      }
    }
    const built = createAuditCorpus([{ session_id: 'outcome', events }], sha256);
    const summary = verifyAuditCorpus(built.content, sha256).manifest.sessions[0]!;
    expect(summary).toMatchObject({
      attribution: 'declared',
      proof_plan_binding: binding,
      outcome: {
        state: 'completed',
        state_version: 13,
        terminal: true,
        pre_pr_implementation_entries: 2,
        repair_entries_consumed: 1,
        setup_failed_count: 3,
        gate_failures_by_id: { check: 3 },
        wall_clock_to_completed_ms: (events.length - 1) * 1000,
      },
    });
  },
);

function transitionHistory(states: readonly TaskStatus[], coverage: 'current' | 'legacy' | 'activation') {
  const sessionId = 'lifecycle';
  const activation = coverage === 'activation';
  const firstVersion = activation ? 8 : 0;
  const events: StoredAuditEvent[] = [];
  for (const [index, state] of states.entries()) {
    const stateVersion = firstVersion + index;
    const payload =
      index > 0
        ? {
            from_state: states[index - 1],
            to_state: state,
            from_state_version: stateVersion - 1,
            to_state_version: stateVersion,
          }
        : activation
          ? { coverage: 'schema_v6_forward', lifecycle_state_at_activation: state }
          : { lifecycle_state: state, ...(coverage === 'current' ? { run_configuration: descriptor } : {}) };
    const eventType = index > 0 ? 'transition_applied' : activation ? 'audit_activated' : 'session_started';
    appendEvent(events, sessionId, eventType, stateVersion, payload);
  }
  return { session_id: sessionId, events };
}

const toVerifying = ['queued', 'framed', 'proof_ready', 'implementing', 'verifying'] as const;

it.each([
  ['legacy', ['queued', 'completed']],
  ['current', [...toVerifying, 'reviewing']],
  ['legacy', [...toVerifying, 'implementing', 'verifying', 'reviewing']],
  ['legacy', ['queued', 'framed', 'blocked', 'queued']],
  ['activation', ['blocked', 'blocked']],
  ['activation', ['blocked', 'completed']],
  ['activation', ['blocked', 'verifying', 'blocked', 'reviewing']],
  ['activation', ['ready_for_human', 'completed', 'blocked']],
  ['activation', ['reviewing', 'repairing', 'verifying', 'implementing']],
] as const)('rejects a hash-valid %s history with an impossible transition %j', (coverage, states) => {
  const history = transitionHistory(states, coverage);
  expect(() => createAuditCorpus([history], sha256)).toThrow(/lifecycle transition/);
});

it.each([
  ['legacy', [...toVerifying, 'reviewing', 'ready_for_human', 'completed']],
  ['current', ['queued', 'framed', 'blocked', 'framed', 'proof_ready']],
  ['activation', ['blocked', 'reviewing', 'repairing', 'verifying', 'reviewing']],
  ['activation', ['verifying', 'reviewing']],
] as const)('preserves a valid %s history through export and verification %j', (coverage, states) => {
  const corpus = createAuditCorpus([transitionHistory(states, coverage)], sha256);
  expect(verifyAuditCorpus(corpus.content, sha256, corpus.root).manifest.sessions[0]).toMatchObject({
    coverage: coverage === 'activation' ? 'schema_v6_forward' : 'full',
    outcome: { state: states.at(-1) },
  });
});

it('requires a full audit history to start in queued', () => {
  expect(() => createAuditCorpus([transitionHistory(['completed'], 'legacy')], sha256)).toThrow(/Session start/);
});

it.each([
  ['guard_decision', 'verifying'],
  ['proof_receipt_recorded', 'verifying'],
  ['signed_proof_receipt_imported', 'verifying'],
  ['signed_review_receipt_imported', 'reviewing'],
] as const)('checks the observed state version of %s from an activation boundary', (type, state) => {
  for (const version of [7, 8, 9]) {
    const history = transitionHistory([state], 'activation');
    appendEvent(history.events, history.session_id, type, version, {});
    if (version === 8) {
      const corpus = createAuditCorpus([history], sha256);
      expect(verifyAuditCorpus(corpus.content, sha256).valid).toBe(true);
    } else {
      expect(() => createAuditCorpus([history], sha256)).toThrow(/state version/);
    }
  }
});

it.each(['session_started', 'audit_activated'] as const)('rejects a second %s at the current state version', (type) => {
  const history = session();
  const payload =
    type === 'session_started'
      ? history.events[0]!.value.payload
      : { coverage: 'schema_v6_forward', lifecycle_state_at_activation: 'queued' };
  appendEvent(history.events, history.session_id, type, 0, payload);
  expect(() => createAuditCorpus([history], sha256)).toThrow(/genesis/);
});

it('uses the prior version for a guard decision and advances on the applied transition', () => {
  const history = session();
  const append = (type: AuditEventType, version: number, payload: Record<string, unknown>) =>
    appendEvent(history.events, history.session_id, type, version, payload);
  append('guard_decision', 0, { from_state: 'queued', target_state: 'framed', allowed: true });
  append('transition_applied', 1, {
    from_state: 'queued',
    to_state: 'framed',
    from_state_version: 0,
    to_state_version: 1,
  });
  const rejection = { from_state: 'framed', target_state: 'completed', allowed: false };
  append('guard_decision', 1, rejection);
  const corpus = createAuditCorpus([history], sha256);
  expect(verifyAuditCorpus(corpus.content, sha256).manifest.sessions[0]?.outcome.state_version).toBe(1);
  append('guard_decision', 0, rejection);
  expect(() => createAuditCorpus([history], sha256)).toThrow(/state version 1/);
});

it('verifies a forward activation only up to the largest safe integer state version', () => {
  const history = transitionHistory(['framed'], 'activation');
  const { manifest } = createAuditCorpus([history], sha256);
  const summary = manifest.sessions[0]!;
  // Rewrite the retained event and every dependent hash so only the version can invalidate the file.
  const atVersion = (version: number) => {
    const canonicalEvent = canonicalJson({ ...history.events[0]!.value, state_version: version });
    const root = sha256(canonicalEvent);
    const session = { ...summary, root, outcome: { ...summary.outcome, state_version: version } };
    const record = {
      record_type: 'event',
      session_id: history.session_id,
      canonical_event: canonicalEvent,
      event_sha256: root,
    };
    const prefix = canonicalJson({ ...manifest, sessions: [session] }) + '\n' + canonicalJson(record) + '\n';
    const seal = { record_type: 'seal', session_count: 1, event_count: 1, prefix_sha256: sha256(prefix) };
    return prefix + canonicalJson(seal) + '\n';
  };
  const safe = atVersion(Number.MAX_SAFE_INTEGER);
  expect(verifyAuditCorpus(safe, sha256, sha256(safe)).valid).toBe(true);
  const unsafe = atVersion(Number.MAX_SAFE_INTEGER + 1);
  expect(() => verifyAuditCorpus(unsafe, sha256, sha256(unsafe))).toThrow(/invalid JSON, fields/);
});
