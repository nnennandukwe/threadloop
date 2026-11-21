import { expect, it, vi } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { createAuditEvent, ZERO_AUDIT_HASH, type StoredAuditEvent } from '../../src/domain/audit.js';
import { createAuditCorpus } from '../../src/domain/audit-corpus.js';
import {
  AuditCorpusLimitError,
  MAX_AUDIT_CORPUS_BYTES,
  MAX_AUDIT_CORPUS_RECORDS,
} from '../../src/domain/audit-corpus-limits.js';
import { AUDIT_OTEL_PROFILE, renderAuditOtel } from '../../src/domain/audit-otel.js';
import { AuditOtelProjectionError, verifyAuditOtel } from '../../src/domain/audit-otel-verification.js';

function sample() {
  const events: StoredAuditEvent[] = [];
  function append(
    eventType: StoredAuditEvent['value']['event_type'],
    stateVersion: number,
    payload: Record<string, unknown>,
  ) {
    events.push(
      createAuditEvent(
        {
          id: `e-${events.length}`,
          sessionId: 's1',
          sequence: events.length + 1,
          eventType,
          recordedAt: '2026-11-14T17:00:00.000Z',
          stateVersion,
          previousSha256: events.at(-1)?.sha256 ?? ZERO_AUDIT_HASH,
          payload,
        },
        sha256,
      ),
    );
  }
  append('session_started', 0, { lifecycle_state: 'queued', task_id: 't1', note: 'line one\nline two\r\n\u7814' });
  append('guard_decision', 0, { from_state: 'queued', target_state: 'framed', allowed: true });
  append('transition_applied', 1, {
    from_state: 'queued',
    to_state: 'framed',
    from_state_version: 0,
    to_state_version: 1,
    transition_id: 'transition_1',
    request_sha256: 'a'.repeat(64),
  });
  const second = createAuditEvent(
    {
      id: 'legacy',
      sessionId: 's2',
      sequence: 1,
      eventType: 'audit_activated',
      recordedAt: '2026-11-14T17:00:00.000Z',
      stateVersion: 8,
      previousSha256: ZERO_AUDIT_HASH,
      payload: { coverage: 'schema_v6_forward', lifecycle_state_at_activation: 'blocked' },
    },
    sha256,
  );
  return createAuditCorpus(
    [
      { session_id: 's1', events },
      { session_id: 's2', events: [second] },
    ],
    sha256,
  );
}

type Attribute = { key: string; value: Record<string, unknown> };
type TestRow = {
  resourceLogs: {
    schemaUrl: string;
    scopeLogs: {
      scope: { attributes: Attribute[] };
      logRecords: { eventName: string; attributes: Attribute[] }[];
    }[];
  }[];
};

function rows(content: string): TestRow[] {
  return content
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as TestRow);
}

function inspectionFile(change: (data: TestRow[]) => void) {
  const data = rows(renderAuditOtel(sample(), 'otel-verifiable', sha256).content);
  change(data);
  return data.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function attributes(row: TestRow) {
  return row.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes;
}

function nativeRecord(row: TestRow) {
  return attributes(row).find((attribute) => attribute.key === 'threadloop.audit.canonical_record')!;
}

it('rebuilds the mixed native corpus once and returns separate outer and source roots', () => {
  const native = sample();
  const outer = renderAuditOtel(native, 'otel-verifiable', sha256);
  const digest = vi.fn(sha256);
  const verified = verifyAuditOtel(outer.content, digest, outer.root);
  expect(verified).toMatchObject({
    valid: true,
    format: 'otel-verifiable',
    profile: AUDIT_OTEL_PROFILE,
    root: outer.root,
    source_root: native.root,
    manifest: native.manifest,
    session_count: 2,
    event_count: 4,
  });
  expect(digest.mock.calls.filter(([bytes]) => bytes === native.content)).toHaveLength(1);
  expect(verifyAuditOtel(outer.content, sha256)).toEqual(verified);
  expect(() => verifyAuditOtel(outer.content, sha256, native.root)).toThrow(/root/);
  expect(() => verifyAuditOtel(outer.content, sha256, 'short')).toThrow(/root/);
});

it('identifies a viewer projection and gives a recovery command', () => {
  const viewer = renderAuditOtel(sample(), 'otel', sha256);
  expect(() => verifyAuditOtel(viewer.content, sha256, viewer.root)).toThrow(AuditOtelProjectionError);
  expect(() => verifyAuditOtel(viewer.content, sha256)).toThrow('--format otel-verifiable');
  expect(() => verifyAuditOtel(viewer.content, sha256, sample().root)).toThrow(AuditOtelProjectionError);
});

const corruptions: Record<string, (data: TestRow[]) => void> = {
  'missing seal': (data) => {
    data.pop();
  },
  'missing event': (data) => {
    data.splice(2, 1);
  },
  'duplicate event': (data) => {
    data.splice(2, 0, data[1]!);
  },
  'reordered events': (data) => {
    [data[1], data[2]] = [data[2]!, data[1]!];
  },
  'additional record': (data) => {
    data.push(data.at(-1)!);
  },
  'additional resource': (data) => {
    const resources = data[0]!.resourceLogs;
    resources.push(resources[0]!);
  },
  'additional scope': (data) => {
    const scopes = data[0]!.resourceLogs[0]!.scopeLogs;
    scopes.push(scopes[0]!);
  },
  'additional log': (data) => {
    const logs = data[0]!.resourceLogs[0]!.scopeLogs[0]!.logRecords;
    logs.push(logs[0]!);
  },
  'changed convention version': (data) => {
    data[0]!.resourceLogs[0]!.schemaUrl = 'unknown';
  },
  'changed native root': (data) => {
    attributes(data[0]!).find((attribute) => attribute.key === 'threadloop.audit.source_root')!.value.stringValue =
      'f'.repeat(64);
  },
  'changed event name': (data) => {
    data[1]!.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.eventName = 'different';
  },
  'incorrect attribute type': (data) => {
    nativeRecord(data[0]!).value = { intValue: '8' };
  },
  'multiple attribute types': (data) => {
    nativeRecord(data[0]!).value.intValue = '8';
  },
  'duplicate canonical attribute': (data) => {
    attributes(data[0]!).push(nativeRecord(data[0]!));
  },
  'missing canonical attribute': (data) => {
    nativeRecord(data[0]!).key = 'other';
  },
  'damaged native event': (data) => {
    nativeRecord(data[1]!).value.stringValue = '{}';
  },
  'embedded carriage return': (data) => {
    nativeRecord(data[1]!).value.stringValue = '{}\r';
  },
  'embedded newline': (data) => {
    nativeRecord(data[1]!).value.stringValue = '{}\n{}';
  },
};
it.each(Object.entries(corruptions))('rejects %s', (_name, change) => {
  expect(() => verifyAuditOtel(inspectionFile(change), sha256)).toThrow();
});

it('rejects a viewer declaration in a controlled stream as inconsistent', () => {
  const mixed = inspectionFile((data) => {
    const scope = data[1]!.resourceLogs[0]!.scopeLogs[0]!.scope;
    scope.attributes.find((a) => a.key === 'threadloop.audit.format')!.value = { stringValue: 'otel' };
  });
  expect(() => verifyAuditOtel(mixed, sha256)).not.toThrow(AuditOtelProjectionError);
  expect(() => verifyAuditOtel(mixed, sha256)).toThrow();
});

it('enforces the physical file limits before decoding and requires a terminating newline', () => {
  expect(() => verifyAuditOtel('\n'.repeat(MAX_AUDIT_CORPUS_RECORDS + 1), sha256)).toThrow(AuditCorpusLimitError);
  expect(() => verifyAuditOtel(' '.repeat(MAX_AUDIT_CORPUS_BYTES) + '\n', sha256)).toThrow(AuditCorpusLimitError);
  const outer = renderAuditOtel(sample(), 'otel-verifiable', sha256);
  expect(() => verifyAuditOtel(outer.content.slice(0, -1), sha256)).toThrow(/newline/);
});
