import type { ThreadloopErrorCode } from '../contracts/errors.js';
import { AUDIT_EVENT_TYPES, type AuditEventValue } from './audit.js';
import { AuditCorpusError, type createAuditCorpus } from './audit-corpus.js';
import { AuditCorpusLimitError, MAX_AUDIT_CORPUS_BYTES, MAX_AUDIT_CORPUS_RECORDS } from './audit-corpus-limits.js';
import { canonicalJson, isPlainObject } from './canonical-json.js';
import type { GateReceiptResult, ProofDigest } from './proof.js';
import type { TaskStatus } from './types.js';

export type AuditOtelFormat = 'otel' | 'otel-verifiable';
export const AUDIT_OTEL_PROFILE = 'threadloop.audit-otel/1';
type Corpus = Pick<
  ReturnType<typeof createAuditCorpus>,
  'content' | 'manifest' | 'session_count' | 'event_count' | 'root'
>;
type Summary = Corpus['manifest']['sessions'][number];
type Fields = Record<string, string | number | boolean | null | undefined>;

const schemaUrl = 'https://opentelemetry.io/schemas/1.37.0';
const sessionId = /^session_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;
const gitSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const serviceVersion = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;
// The profile vocabulary stays pinned when a later native protocol adds cases.
const states = new Set<string>([
  'queued',
  'framed',
  'proof_ready',
  'implementing',
  'verifying',
  'pre_pr_reviewing',
  'reviewing',
  'repairing',
  'ready_for_human',
  'blocked',
  'completed',
] satisfies TaskStatus[]);
const guardCodes = [
  'IDEMPOTENCY_CONFLICT',
  'STATE_VERSION_CONFLICT',
  'TRANSITION_NOT_ALLOWED',
  'TRANSITION_GUARD_FAILED',
] satisfies ThreadloopErrorCode[];
const results = [
  'passed',
  'failed',
  'timed_out',
  'aborted',
  'invalidated',
  'execution_error',
  'cleanup_failed',
  'setup_failed',
] satisfies GateReceiptResult[];

function matching(value: unknown, pattern: RegExp) {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function state(value: unknown) {
  return typeof value === 'string' && states.has(value) ? value : undefined;
}

function integer(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function attributes(fields: Fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ({
      key,
      value:
        typeof value === 'boolean'
          ? { boolValue: value }
          : typeof value === 'number'
            ? { intValue: String(value) }
            : { stringValue: value },
    }));
}

function timeUnixNano(iso: string) {
  // The native schema accepts Z or a six-character offset. Parse whole seconds separately to retain nanoseconds.
  const zoneStart = iso.length - (iso.endsWith('Z') ? 1 : 6);
  const dot = iso.indexOf('.');
  const fraction = dot < 0 ? '' : iso.slice(dot + 1, zoneStart);
  if (/[1-9]/.test(fraction.slice(9))) return undefined;
  const milliseconds = Date.parse(dot < 0 ? iso : iso.slice(0, dot) + iso.slice(zoneStart));
  if (!Number.isFinite(milliseconds)) return undefined;
  const nanos = BigInt(milliseconds) * 1_000_000n + BigInt(fraction.slice(0, 9).padEnd(9, '0'));
  return nanos > 0n && nanos <= 0xffff_ffff_ffff_ffffn ? nanos.toString() : undefined;
}

function checkEmbeddedRecordSize(nativeLine: string, remaining: number) {
  let bytes = Buffer.byteLength(nativeLine) + 2;
  if (bytes >= remaining) throw new AuditCorpusLimitError();
  if (2 * bytes < remaining) return;
  // A canonical native line has no raw control characters. Only quotes and backslashes need another escape.
  for (let i = 0; i < nativeLine.length; i++) {
    const character = nativeLine.charCodeAt(i);
    if (character === 34 || character === 92) {
      bytes++;
      if (bytes >= remaining) throw new AuditCorpusLimitError();
    }
  }
}

function governanceFields(event: AuditEventValue, summary: Summary): Fields {
  const payload = event.payload;
  switch (event.event_type) {
    case 'session_started':
    case 'audit_activated': {
      const config = summary.run_configuration;
      return {
        'threadloop.lifecycle.state': state(
          event.event_type === 'session_started' ? payload.lifecycle_state : payload.lifecycle_state_at_activation,
        ),
        'threadloop.evidence.head_sha': matching(payload.head_sha, gitSha),
        'threadloop.run.implementation_sha256': config?.implementation_sha256,
        'threadloop.run.proof_plan_sha256': config?.proof_plan_sha256,
        'threadloop.run.runner_skill_sha256': config?.runner_skill_sha256,
        'threadloop.run.storage_schema_version': config?.storage_schema_version,
        'threadloop.run.protocol_version': config?.protocol_components.protocol,
      };
    }
    case 'guard_decision': {
      const errorCode = isPlainObject(payload.error) ? payload.error.code : undefined;
      return {
        'threadloop.lifecycle.from_state': state(payload.from_state),
        'threadloop.lifecycle.target_state': state(payload.target_state),
        'threadloop.guard.allowed': typeof payload.allowed === 'boolean' ? payload.allowed : undefined,
        'threadloop.guard.error_code':
          payload.allowed === false ? guardCodes.find((code) => code === errorCode) : undefined,
        'threadloop.evidence.request_sha256': matching(payload.request_sha256, sha256),
      };
    }
    case 'transition_applied':
      return {
        'threadloop.lifecycle.from_state': state(payload.from_state),
        'threadloop.lifecycle.to_state': state(payload.to_state),
        'threadloop.lifecycle.from_state_version': integer(payload.from_state_version),
        'threadloop.lifecycle.to_state_version': integer(payload.to_state_version),
        'threadloop.evidence.request_sha256': matching(payload.request_sha256, sha256),
        'threadloop.evidence.proof_plan_sha256': matching(payload.proof_plan_sha256, sha256),
      };
    case 'proof_receipt_recorded':
      return {
        'threadloop.receipt.result': results.find((result) => result === payload.result),
        'threadloop.evidence.receipt_sha256': matching(payload.receipt_sha256, sha256),
        'threadloop.evidence.head_sha': matching(payload.head_sha, gitSha),
      };
    case 'signed_proof_receipt_imported':
    case 'signed_review_receipt_imported':
      return {
        'threadloop.evidence.package_sha256': matching(payload.package_sha256, sha256),
        'threadloop.evidence.head_sha': matching(payload.subject_head_sha, gitSha),
        'threadloop.review.merged':
          event.event_type === 'signed_review_receipt_imported' && typeof payload.merged === 'boolean'
            ? payload.merged
            : undefined,
      };
  }
}

function outcomeFields(summary: Summary): Fields {
  const outcome = summary.outcome;
  return {
    'threadloop.outcome.state': state(outcome.state),
    'threadloop.outcome.terminal': outcome.terminal,
    'threadloop.outcome.counts_scope': outcome.counts_scope,
    'threadloop.outcome.pre_pr_implementation_entries': outcome.pre_pr_implementation_entries,
    'threadloop.outcome.repair_entries_consumed': outcome.repair_entries_consumed,
    'threadloop.outcome.setup_failed_count': outcome.setup_failed_count,
    'threadloop.outcome.gate_failure_count': Object.values(outcome.gate_failures_by_id).reduce(
      (total, n) => total + n,
      0,
    ),
    'threadloop.outcome.wall_clock_to_completed_ms': outcome.wall_clock_to_completed_ms,
  };
}

/** Projects a corpus already checked by the native writer or standalone verifier. */
export function renderAuditOtel(corpus: Corpus, format: AuditOtelFormat, digest: ProofDigest) {
  if (corpus.event_count + 2 > MAX_AUDIT_CORPUS_RECORDS || Buffer.byteLength(corpus.content) > MAX_AUDIT_CORPUS_BYTES)
    throw new AuditCorpusLimitError();
  const summaries = new Map(corpus.manifest.sessions.map((s) => [s.session_id, s]));
  const scope = {
    name: 'threadloop.audit',
    version: '1',
    attributes: attributes({
      'threadloop.audit.profile': AUDIT_OTEL_PROFILE,
      'threadloop.audit.format': format,
      'threadloop.otel.specification_version': '1.49.0',
      'threadloop.otel.protobuf_version': '1.7.0',
    }),
  };
  const lines: string[] = [];
  let remaining = MAX_AUDIT_CORPUS_BYTES;
  let position = 0;
  while (position < corpus.content.length) {
    const end = corpus.content.indexOf('\n', position);
    if (end < 0) throw new AuditCorpusError('The native corpus must end with a newline.');
    if (lines.length >= MAX_AUDIT_CORPUS_RECORDS) throw new AuditCorpusLimitError();
    const nativeLine = corpus.content.slice(position, end);
    const controlled = format === 'otel-verifiable';
    if (controlled) checkEmbeddedRecordSize(nativeLine, remaining);
    const fields: Fields = { 'threadloop.audit.source_root': corpus.root };
    let name: string;
    let timestamp: string | undefined;
    let version: string | undefined;
    if (position === 0 || end === corpus.content.length - 1) {
      name = position === 0 ? 'manifest' : 'seal';
      fields['threadloop.audit.session_count'] = corpus.session_count;
      fields['threadloop.audit.event_count'] = corpus.event_count;
    } else {
      const row = JSON.parse(nativeLine) as { canonical_event: string; event_sha256: string };
      const event = JSON.parse(row.canonical_event) as AuditEventValue;
      const summary = summaries.get(event.session_id);
      if (!summary || !AUDIT_EVENT_TYPES.includes(event.event_type))
        throw new AuditCorpusError('Unknown native event or session.');
      name = event.event_type;
      timestamp = timeUnixNano(event.recorded_at);
      version = matching(summary.run_configuration?.threadloop_version, serviceVersion);
      Object.assign(
        fields,
        {
          'threadloop.session.id': matching(event.session_id, sessionId),
          'threadloop.session.root': summary.root,
          'threadloop.session.coverage': summary.coverage,
          'threadloop.session.attribution': summary.attribution,
          'threadloop.session.proof_plan_binding': summary.proof_plan_binding,
          'threadloop.audit.event_sha256': row.event_sha256,
          'threadloop.audit.previous_sha256': event.previous_sha256,
          'threadloop.audit.sequence': event.sequence,
          'threadloop.audit.state_version': event.state_version,
        },
        governanceFields(event, summary),
      );
      if (event.sequence === summary.count) Object.assign(fields, outcomeFields(summary));
    }
    if (controlled) fields['threadloop.audit.canonical_record'] = nativeLine;
    const log = { eventName: `threadloop.audit.${name}`, timeUnixNano: timestamp, attributes: attributes(fields) };
    const resource = { attributes: attributes({ 'service.name': 'threadloop', 'service.version': version }) };
    const line = canonicalJson({ resourceLogs: [{ schemaUrl, resource, scopeLogs: [{ scope, logRecords: [log] }] }] });
    remaining -= Buffer.byteLength(line) + 1;
    if (remaining < 0) throw new AuditCorpusLimitError();
    lines.push(line);
    position = end + 1;
  }
  const content = lines.join('\n') + '\n';
  return { content, root: digest(content) };
}
