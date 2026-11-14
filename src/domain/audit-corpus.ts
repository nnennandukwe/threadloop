import { z } from 'zod';
import { AUDIT_EVENT_TYPES, verifyAuditChain, type StoredAuditEvent } from './audit.js';
import { canonicalJson } from './canonical-json.js';
import { isRepairEntryTransition } from './lifecycle.js';
import type { ProofDigest } from './proof.js';
import { runConfigurationSchema } from './run-configuration.js';
import { isTaskStatus } from './types.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const eventSchema = z.strictObject({
  schema_version: z.literal(1),
  id: z.string().min(1),
  session_id: z.string().min(1),
  sequence: z.number().int().positive(),
  event_type: z.enum(AUDIT_EVENT_TYPES),
  recorded_at: z.iso.datetime({ offset: true }),
  state_version: count,
  previous_sha256: hash,
  payload: z.record(z.string(), z.unknown()),
});
const eventRecordSchema = z.strictObject({
  record_type: z.literal('event'),
  session_id: z.string().min(1),
  canonical_event: z.string(),
  event_sha256: hash,
});
const manifestSchema = z.strictObject({
  record_type: z.literal('manifest'),
  schema_version: z.literal('threadloop.audit-corpus/1'),
  comparison_unit: z.literal('session'),
  sessions: z.array(z.looseObject({ session_id: z.string().min(1), count: z.number().int().positive() })).min(1),
});

export interface AuditCorpusSession {
  session_id: string;
  events: StoredAuditEvent[];
}

export class AuditCorpusError extends Error {}

export function projectAuditSession(session: AuditCorpusSession, digest: ProofDigest) {
  const verification = verifyAuditChain(session.events, digest);
  if (!verification.valid || session.events.length === 0)
    throw new AuditCorpusError('Session audit chain is invalid or empty.');
  for (const event of session.events) {
    eventSchema.parse(event.value);
    if (event.value.session_id !== session.session_id)
      throw new AuditCorpusError('Audit event belongs to another session.');
  }
  const genesis = session.events[0]!.value;
  const coverage =
    genesis.event_type === 'session_started'
      ? 'full'
      : genesis.event_type === 'audit_activated' && genesis.payload.coverage === 'schema_v6_forward'
        ? 'schema_v6_forward'
        : null;
  if (coverage === null) throw new AuditCorpusError('Session audit coverage is unknown.');
  const configuration =
    genesis.payload.run_configuration === undefined
      ? null
      : runConfigurationSchema.parse(genesis.payload.run_configuration);
  let state =
    genesis.event_type === 'session_started'
      ? genesis.payload.lifecycle_state
      : genesis.payload.lifecycle_state_at_activation;
  if (typeof state !== 'string' || !isTaskStatus(state))
    throw new AuditCorpusError('Audit genesis lifecycle state is invalid.');
  let stateVersion = genesis.state_version;
  let postPr = ['reviewing', 'ready_for_human', 'completed'].includes(state);
  let implementationEntries = 0;
  let repairs = 0;
  let setupFailures = 0;
  let completedAt: string | null = null;
  let boundPlan: string | null = null;
  const gateFailures = new Map<string, number>();
  for (const { value: event } of session.events) {
    const payload = event.payload;
    if (event.event_type === 'transition_applied') {
      const from = payload.from_state;
      const to = payload.to_state;
      if (
        typeof from !== 'string' ||
        !isTaskStatus(from) ||
        typeof to !== 'string' ||
        !isTaskStatus(to) ||
        from !== state ||
        payload.from_state_version !== stateVersion ||
        payload.to_state_version !== event.state_version ||
        event.state_version !== stateVersion + 1
      )
        throw new AuditCorpusError('Audit transitions are inconsistent.');
      if (!postPr && to === 'implementing') implementationEntries++;
      if (isRepairEntryTransition(from, to)) repairs++;
      postPr ||= ['reviewing', 'ready_for_human', 'completed'].includes(to);
      state = to;
      stateVersion = event.state_version;
      if (to === 'completed') completedAt = event.recorded_at;
      if (payload.proof_plan_sha256 !== undefined) boundPlan = hash.parse(payload.proof_plan_sha256);
    }
    if (event.event_type === 'proof_receipt_recorded') {
      if (payload.result === 'setup_failed') setupFailures++;
      else if (payload.result !== 'passed' && typeof payload.gate_id === 'string') {
        gateFailures.set(payload.gate_id, (gateFailures.get(payload.gate_id) ?? 0) + 1);
      }
    }
  }
  const startedAt = coverage === 'full' ? genesis.recorded_at : null;
  const elapsed = completedAt !== null && startedAt !== null ? Date.parse(completedAt) - Date.parse(startedAt) : null;
  return {
    session_id: session.session_id,
    count: session.events.length,
    root: verification.root,
    coverage,
    run_configuration: configuration,
    attribution:
      configuration === null ? 'legacy_unattributable' : configuration.caller === null ? 'runtime_only' : 'declared',
    proof_plan_binding:
      configuration?.proof_plan_sha256 == null
        ? 'unknown'
        : boundPlan === null
          ? 'unbound'
          : boundPlan === configuration.proof_plan_sha256
            ? 'matched'
            : 'mismatched',
    outcome: {
      state,
      state_version: stateVersion,
      terminal: state === 'completed',
      started_at: startedAt,
      observed_at: session.events.at(-1)!.value.recorded_at,
      completed_at: completedAt,
      wall_clock_to_completed_ms: elapsed !== null && elapsed >= 0 ? elapsed : null,
      counts_scope: coverage === 'full' ? 'session' : 'covered_events',
      pre_pr_implementation_entries: coverage === 'full' ? implementationEntries : null,
      repair_entries_consumed: repairs,
      setup_failed_count: setupFailures,
      gate_failures_by_id: Object.fromEntries([...gateFailures].sort()),
      wake_count: null,
      stop_only_handoff_count: null,
    },
  };
}

export function createAuditCorpus(sessions: AuditCorpusSession[], digest: ProofDigest) {
  const ordered = [...sessions].sort((left, right) =>
    left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0,
  );
  if (ordered.length === 0 || new Set(ordered.map((session) => session.session_id)).size !== ordered.length) {
    throw new AuditCorpusError('Select at least one session, with no duplicate session ids.');
  }
  const manifest = {
    record_type: 'manifest',
    schema_version: 'threadloop.audit-corpus/1',
    comparison_unit: 'session',
    sessions: ordered.map((session) => projectAuditSession(session, digest)),
  };
  const lines = [canonicalJson(manifest)];
  let eventCount = 0;
  for (const session of ordered) {
    for (const event of session.events) {
      lines.push(
        canonicalJson({
          record_type: 'event',
          session_id: session.session_id,
          canonical_event: event.json,
          event_sha256: event.sha256,
        }),
      );
      eventCount++;
    }
  }
  const prefix = lines.join('\n') + '\n';
  const content =
    prefix +
    canonicalJson({
      record_type: 'seal',
      prefix_sha256: digest(prefix),
      session_count: ordered.length,
      event_count: eventCount,
    }) +
    '\n';
  return { content, root: digest(content), manifest, session_count: ordered.length, event_count: eventCount };
}

/** Rebuilds the complete format from retained event bytes; no repository or database is consulted. */
export function verifyAuditCorpus(content: string, digest: ProofDigest, expectedRoot?: string) {
  try {
    if (!content.endsWith('\n')) throw new AuditCorpusError('Corpus must end with a newline and a complete seal.');
    if (expectedRoot !== undefined && hash.parse(expectedRoot) !== digest(content))
      throw new AuditCorpusError('Retained corpus root does not match.');
    const lines = content.slice(0, -1).split('\n');
    const manifest = manifestSchema.parse(JSON.parse(lines[0]!));
    let cursor = 1;
    const sessions: AuditCorpusSession[] = [];
    for (const summary of manifest.sessions) {
      if (summary.count > lines.length - cursor - 1) throw new AuditCorpusError('Corpus is incomplete.');
      const events: StoredAuditEvent[] = [];
      for (let index = 0; index < summary.count; index++) {
        const record = eventRecordSchema.parse(JSON.parse(lines[cursor++]!));
        if (record.session_id !== summary.session_id)
          throw new AuditCorpusError('Corpus session membership is inconsistent.');
        events.push({
          value: eventSchema.parse(JSON.parse(record.canonical_event)),
          json: record.canonical_event,
          sha256: record.event_sha256,
        });
      }
      sessions.push({ session_id: summary.session_id, events });
    }
    const rebuilt = createAuditCorpus(sessions, digest);
    if (content !== rebuilt.content)
      throw new AuditCorpusError('Corpus framing, projections, bytes, or seal do not match retained events.');
    return {
      valid: true as const,
      root: rebuilt.root,
      manifest: rebuilt.manifest,
      session_count: rebuilt.session_count,
      event_count: rebuilt.event_count,
    };
  } catch (cause) {
    if (cause instanceof AuditCorpusError) throw cause;
    throw new AuditCorpusError('Corpus contains invalid JSON, fields, or an unsupported schema.', { cause });
  }
}
