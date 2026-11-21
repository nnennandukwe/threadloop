import { expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  createAuditEvent,
  ZERO_AUDIT_HASH,
  type AuditEventType,
  type StoredAuditEvent,
} from '../../src/domain/audit.js';
import { createAuditCorpus } from '../../src/domain/audit-corpus.js';
import { AuditCorpusLimitError } from '../../src/domain/audit-corpus-limits.js';
import { renderAuditOtel } from '../../src/domain/audit-otel.js';

const sessionId = 'session_00000000-0000-4000-8000-000000000001';
type Observed = [AuditEventType, Record<string, unknown>];
type Attribute = { key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } };
interface Envelope {
  resourceLogs: [
    {
      resource: { attributes: Attribute[] };
      scopeLogs: [{ logRecords: [{ eventName: string; timeUnixNano?: string; attributes: Attribute[] }] }];
    },
  ];
}

function corpus(events: Observed[], id = sessionId, at = '1970-01-01T00:00:01.123456789Z') {
  const stored: StoredAuditEvent[] = [];
  for (const [eventType, payload] of events) {
    stored.push(
      createAuditEvent(
        {
          id: `event-${stored.length}`,
          sessionId: id,
          sequence: stored.length + 1,
          eventType,
          recordedAt: at,
          stateVersion: 0,
          previousSha256: stored.at(-1)?.sha256 ?? ZERO_AUDIT_HASH,
          payload,
        },
        sha256,
      ),
    );
  }
  return createAuditCorpus([{ session_id: id, events: stored }], sha256);
}

function resources(content: string) {
  return content
    .trimEnd()
    .split('\n')
    .map((line) => (JSON.parse(line) as Envelope).resourceLogs[0]);
}

const genesis: Observed = ['session_started', { lifecycle_state: 'queued' }];

it('pins the viewer and controlled file bytes for a fixed native session', () => {
  const source = corpus([genesis]);
  const viewer = renderAuditOtel(source, 'otel', sha256);
  const controlled = renderAuditOtel(source, 'otel-verifiable', sha256);
  expect([viewer.root, controlled.root]).toMatchInlineSnapshot(`
    [
      "497fa273e97e5b72689d14b6deb311f353b3c816b03e6cac153b86a52ea1dfc7",
      "e5c4c77fa838dcb8ddf52203431273e2b0303664a0eec0a9a2d20403a3719cdb",
    ]
  `);
  const recovered = resources(controlled.content).map(
    (r) =>
      r.scopeLogs[0].logRecords[0].attributes.find((a) => a.key === 'threadloop.audit.canonical_record')!.value
        .stringValue,
  );
  expect(recovered.join('\n') + '\n').toBe(source.content);
  expect(sha256(viewer.content)).toBe(viewer.root);
  expect(sha256(controlled.content)).toBe(controlled.root);
});

it('projects known receipt and guard observations while withholding gate names, arbitrary ids, and guard details', () => {
  const privateText = 'private-\u6e2c\u8a66';
  const source = corpus(
    [
      ['audit_activated', { coverage: 'schema_v6_forward', lifecycle_state_at_activation: 'verifying' }],
      [
        'guard_decision',
        {
          from_state: 'verifying',
          target_state: privateText,
          allowed: false,
          error: { code: 'TRANSITION_GUARD_FAILED', details: { message: privateText } },
          idempotency_key: privateText,
        },
      ],
      [
        'proof_receipt_recorded',
        {
          receipt_id: 'private-receipt',
          gate_id: 'private-gate',
          result: 'setup_failed',
          receipt_sha256: 'a'.repeat(64),
          head_sha: 'f'.repeat(40),
        },
      ],
      [
        'signed_review_receipt_imported',
        { receipt_id: privateText, package_sha256: 'b'.repeat(64), subject_head_sha: privateText, merged: false },
      ],
    ],
    privateText,
  );
  const viewer = renderAuditOtel(source, 'otel', sha256);
  expect(source.content).toContain(privateText);
  expect(viewer.content).not.toContain(privateText);
  expect(viewer.content).not.toContain('private-receipt');
  expect(viewer.content).not.toContain('private-gate');
  expect(viewer.content).not.toContain('service.version');
  expect(viewer.content).not.toContain('threadloop.session.id');
  const rows = resources(viewer.content).map((r) =>
    Object.fromEntries(r.scopeLogs[0].logRecords[0].attributes.map((a) => [a.key, a.value])),
  );
  expect(rows[2]).toMatchObject({
    'threadloop.guard.allowed': { boolValue: false },
    'threadloop.guard.error_code': { stringValue: 'TRANSITION_GUARD_FAILED' },
    'threadloop.lifecycle.from_state': { stringValue: 'verifying' },
    'threadloop.audit.state_version': { intValue: '0' },
  });
  expect(Object.keys(rows[2]!)).not.toContain('threadloop.lifecycle.target_state');
  expect(rows[3]).toMatchObject({
    'threadloop.receipt.result': { stringValue: 'setup_failed' },
    'threadloop.evidence.receipt_sha256': { stringValue: 'a'.repeat(64) },
    'threadloop.evidence.head_sha': { stringValue: 'f'.repeat(40) },
  });
  expect(rows[4]).toMatchObject({
    'threadloop.review.merged': { boolValue: false },
    'threadloop.evidence.package_sha256': { stringValue: 'b'.repeat(64) },
    'threadloop.outcome.setup_failed_count': { intValue: '1' },
    'threadloop.outcome.gate_failure_count': { intValue: '0' },
  });
  expect(Object.keys(rows[4]!)).not.toContain('threadloop.outcome.pre_pr_implementation_entries');
});

it.each([
  ['1970-01-01T01:00:01.123456789+01:00', '1123456789'],
  ['1970-01-01T00:00:00.000000001000Z', '1'],
  ['2554-07-21T23:34:33.709551615Z', '18446744073709551615'],
  ['2554-07-21T23:34:33.709551616Z', undefined],
  ['1970-01-01T00:00:00.0000000001Z', undefined],
  ['1970-01-01T00:00:00Z', undefined],
  ['1969-12-31T23:59:59.999999999Z', undefined],
] as const)('maps the precision and range of the native timestamp %s', (at, expected) => {
  const viewer = renderAuditOtel(corpus([genesis], sessionId, at), 'otel', sha256);
  const event = resources(viewer.content)[1]!.scopeLogs[0].logRecords[0];
  expect(event.timeUnixNano).toBe(expected);
});

it('rejects a native record that exceeds the file budget when escaped inside a controlled envelope', () => {
  const source = corpus([['session_started', { lifecycle_state: 'queued', note: '"'.repeat(3 * 1024 * 1024) }]]);
  expect(() => renderAuditOtel(source, 'otel-verifiable', sha256)).toThrow(AuditCorpusLimitError);
  expect(renderAuditOtel(source, 'otel', sha256).content.length).toBeLessThan(8192);
});
