import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { createAuditEvent, verifyAuditChain, ZERO_AUDIT_HASH } from '../../src/domain/audit.js';

describe('audit hash chain', () => {
  it('hash-links canonical events and reports the final root', () => {
    const first = createAuditEvent(
      {
        id: 'audit_1',
        sessionId: 'session_1',
        sequence: 1,
        eventType: 'audit_activated',
        recordedAt: '2026-07-26T12:00:00.000Z',
        stateVersion: 4,
        previousSha256: ZERO_AUDIT_HASH,
        payload: { coverage: 'schema_v6_forward' },
      },
      sha256,
    );
    const second = createAuditEvent(
      {
        id: 'audit_2',
        sessionId: 'session_1',
        sequence: 2,
        eventType: 'guard_decision',
        recordedAt: '2026-07-26T12:01:00.000Z',
        stateVersion: 4,
        previousSha256: first.sha256,
        payload: { allowed: false, code: 'SIGNED_REVIEW_PROOF_REQUIRED' },
      },
      sha256,
    );

    expect(verifyAuditChain([first, second], sha256)).toEqual({
      valid: true,
      count: 2,
      root: second.sha256,
      error: null,
    });
  });

  it('detects payload tampering and an unexpected externally anchored root', () => {
    const event = createAuditEvent(
      {
        id: 'audit_1',
        sessionId: 'session_1',
        sequence: 1,
        eventType: 'audit_activated',
        recordedAt: '2026-07-26T12:00:00.000Z',
        stateVersion: 4,
        previousSha256: ZERO_AUDIT_HASH,
        payload: { coverage: 'schema_v6_forward' },
      },
      sha256,
    );

    expect(
      verifyAuditChain([{ ...event, json: event.json.replace('schema_v6_forward', 'tampered') }], sha256),
    ).toMatchObject({
      valid: false,
      error: { code: 'AUDIT_CANONICALIZATION_MISMATCH', sequence: 1 },
    });
    expect(verifyAuditChain([event], sha256, 'f'.repeat(64))).toMatchObject({
      valid: false,
      error: { code: 'AUDIT_ROOT_MISMATCH' },
    });
  });

  it('reports stable structured reasons for sequence, link, and hash corruption', () => {
    const first = createAuditEvent(
      {
        id: 'audit_1',
        sessionId: 'session_1',
        sequence: 1,
        eventType: 'session_started',
        recordedAt: '2026-07-26T12:00:00.000Z',
        stateVersion: 0,
        previousSha256: ZERO_AUDIT_HASH,
        payload: {},
      },
      sha256,
    );
    const second = createAuditEvent(
      {
        id: 'audit_2',
        sessionId: 'session_1',
        sequence: 2,
        eventType: 'guard_decision',
        recordedAt: '2026-07-26T12:01:00.000Z',
        stateVersion: 0,
        previousSha256: first.sha256,
        payload: { allowed: false },
      },
      sha256,
    );

    expect(verifyAuditChain([{ ...first, value: { ...first.value, sequence: 2 } }, second], sha256)).toMatchObject({
      valid: false,
      error: { code: 'AUDIT_SEQUENCE_MISMATCH', sequence: 1 },
    });
    expect(
      verifyAuditChain(
        [
          first,
          {
            ...second,
            value: { ...second.value, previous_sha256: 'f'.repeat(64) },
          },
        ],
        sha256,
      ),
    ).toMatchObject({
      valid: false,
      error: { code: 'AUDIT_LINK_MISMATCH', sequence: 2 },
    });
    expect(verifyAuditChain([first, { ...second, sha256: 'f'.repeat(64) }], sha256)).toMatchObject({
      valid: false,
      error: { code: 'AUDIT_HASH_MISMATCH', sequence: 2 },
    });
  });
});
