import { canonicalJson } from './canonical-json.js';
import type { ProofDigest } from './proof.js';

export const ZERO_AUDIT_HASH = '0'.repeat(64);

export const AUDIT_EVENT_TYPES = [
  'session_started',
  'audit_activated',
  'proof_receipt_recorded',
  'signed_proof_receipt_imported',
  'signed_review_receipt_imported',
  'guard_decision',
  'transition_applied',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface AuditEventValue {
  schema_version: 1;
  id: string;
  session_id: string;
  sequence: number;
  event_type: AuditEventType;
  recorded_at: string;
  state_version: number;
  previous_sha256: string;
  payload: Record<string, unknown>;
}

export interface StoredAuditEvent {
  value: AuditEventValue;
  json: string;
  sha256: string;
}

export interface CreateAuditEventInput {
  id: string;
  sessionId: string;
  sequence: number;
  eventType: AuditEventType;
  recordedAt: string;
  stateVersion: number;
  previousSha256: string;
  payload: Record<string, unknown>;
}

export type AuditVerificationErrorCode =
  | 'AUDIT_SEQUENCE_MISMATCH'
  | 'AUDIT_LINK_MISMATCH'
  | 'AUDIT_CANONICALIZATION_MISMATCH'
  | 'AUDIT_HASH_MISMATCH'
  | 'AUDIT_ROOT_MISMATCH';

export interface AuditVerification {
  valid: boolean;
  count: number;
  root: string;
  error: { code: AuditVerificationErrorCode; sequence?: number } | null;
}

export function createAuditEvent(input: CreateAuditEventInput, digest: ProofDigest): StoredAuditEvent {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error('Audit event sequence must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(input.stateVersion) || input.stateVersion < 0) {
    throw new Error('Audit event state version must be a non-negative safe integer.');
  }
  requireSha256(input.previousSha256);
  const value: AuditEventValue = {
    schema_version: 1,
    id: input.id,
    session_id: input.sessionId,
    sequence: input.sequence,
    event_type: input.eventType,
    recorded_at: input.recordedAt,
    state_version: input.stateVersion,
    previous_sha256: input.previousSha256,
    payload: input.payload,
  };
  const json = canonicalJson(value);
  return { value, json, sha256: digest(json) };
}

export function verifyAuditChain(
  events: StoredAuditEvent[],
  digest: ProofDigest,
  expectedRoot?: string,
): AuditVerification {
  let previous = ZERO_AUDIT_HASH;
  for (const [index, event] of events.entries()) {
    const sequence = index + 1;
    if (event.value.sequence !== sequence) {
      return invalid(events, previous, 'AUDIT_SEQUENCE_MISMATCH', sequence);
    }
    if (event.value.previous_sha256 !== previous) {
      return invalid(events, previous, 'AUDIT_LINK_MISMATCH', sequence);
    }
    const canonical = canonicalJson(event.value);
    if (event.json !== canonical) {
      return invalid(events, previous, 'AUDIT_CANONICALIZATION_MISMATCH', sequence);
    }
    if (event.sha256 !== digest(event.json)) {
      return invalid(events, previous, 'AUDIT_HASH_MISMATCH', sequence);
    }
    previous = event.sha256;
  }
  if (expectedRoot !== undefined && previous !== expectedRoot) {
    return {
      valid: false,
      count: events.length,
      root: previous,
      error: { code: 'AUDIT_ROOT_MISMATCH' },
    };
  }
  return { valid: true, count: events.length, root: previous, error: null };
}

function invalid(
  events: StoredAuditEvent[],
  root: string,
  code: Exclude<AuditVerificationErrorCode, 'AUDIT_ROOT_MISMATCH'>,
  sequence: number,
): AuditVerification {
  return {
    valid: false,
    count: events.length,
    root,
    error: { code, sequence },
  };
}

function requireSha256(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error('Audit hash must be 64 lowercase hexadecimal characters.');
  }
}
