import { z } from 'zod';
import { AUDIT_EVENT_TYPES, ZERO_AUDIT_HASH, verifyAuditChain, type StoredAuditEvent } from './audit.js';
import { AuditCorpusLimitError, MAX_AUDIT_CORPUS_BYTES, MAX_AUDIT_CORPUS_RECORDS } from './audit-corpus-limits.js';
import { canonicalJson } from './canonical-json.js';
import { deriveLifecyclePhase, evaluateLifecycleTransition, isRepairEntryTransition } from './lifecycle.js';
import { gateReceiptResult, type ProofDigest } from './proof.js';
import { runConfigurationSchema } from './run-configuration.js';
import { isTaskStatus, LIFECYCLE_PHASE, TASK_STATUS, type TaskStatus } from './types.js';
import { commitSha, identifier, sha256Digest as hash } from './validation.js';

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
const transitionSchema = z.object({
  transition_id: identifier(128),
  request_sha256: hash,
  from_state: z.enum(TASK_STATUS),
  to_state: z.enum(TASK_STATUS),
  from_state_version: count,
  to_state_version: count,
  proof_plan_sha256: hash.optional(),
});
const localReceiptSchema = z.object({
  receipt_id: identifier(128),
  gate_id: identifier(128),
  receipt_sha256: hash,
  head_sha: commitSha.or(hash),
  result: gateReceiptResult,
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
  if (genesis.event_type === 'audit_activated' && genesis.payload.run_configuration !== undefined)
    throw new AuditCorpusError('ThreadLoop records run configuration only at session start.');
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
  if (coverage === 'full' && (state !== 'queued' || genesis.state_version !== 0))
    throw new AuditCorpusError('Session start requires the queued state at version zero.');
  let stateVersion = genesis.state_version;
  let phase = deriveLifecyclePhase([], state);
  // Older writers allowed verifying -> reviewing before the pre-PR review step existed.
  let prePrBoundaryKnown = configuration !== null || state === 'pre_pr_reviewing';
  let blockedFromState: TaskStatus | null = null;
  let implementationEntries = 0;
  let repairs = 0;
  let setupFailures = 0;
  let completedAt: string | null = null;
  let boundPlan: string | null = null;
  const gateFailures = new Map<string, number>();
  const receiptIds = new Set<string>();
  const transitionIds = new Set<string>();
  for (let index = 1; index < session.events.length; index++) {
    const event = session.events[index]!.value;
    if (event.event_type === 'session_started' || event.event_type === 'audit_activated')
      throw new AuditCorpusError('Only the first audit event can establish the session genesis.');
    const payload = event.payload;
    if (event.event_type === 'transition_applied') {
      const parsed = transitionSchema.safeParse(payload);
      if (!parsed.success) throw new AuditCorpusError(`Audit transition ${event.sequence} has invalid fields.`);
      const transition = parsed.data;
      const { from_state: from, to_state: to } = transition;
      if (transitionIds.has(transition.transition_id)) throw new AuditCorpusError('Duplicate audit transition id.');
      transitionIds.add(transition.transition_id);
      if (
        from !== state ||
        transition.from_state_version !== stateVersion ||
        transition.to_state_version !== event.state_version ||
        event.state_version !== stateVersion + 1
      )
        throw new AuditCorpusError('Audit transitions are inconsistent.');
      // A blocked activation omits its predecessor. The resume target must still be a state that could enter blocked.
      const decision =
        from === 'blocked' && blockedFromState === null && coverage === 'schema_v6_forward'
          ? evaluateLifecycleTransition(to, 'blocked')
          : evaluateLifecycleTransition(from, to, {
              blockedFromState,
              ...(prePrBoundaryKnown || phase === LIFECYCLE_PHASE.POST_PR ? { phase } : {}),
            });
      if (!decision.allowed) throw new AuditCorpusError(`Invalid audit lifecycle transition from ${from} to ${to}.`);
      blockedFromState = to === 'blocked' ? from : null;
      if (phase === LIFECYCLE_PHASE.PRE_PR) {
        if (to === 'implementing') implementationEntries++;
        phase = deriveLifecyclePhase([], to);
      }
      prePrBoundaryKnown ||= to === 'pre_pr_reviewing' || (from === 'verifying' && to === 'implementing');
      if (isRepairEntryTransition(from, to)) repairs++;
      state = to;
      stateVersion = event.state_version;
      if (to === 'completed') completedAt = event.recorded_at;
      if (transition.proof_plan_sha256 !== undefined) {
        if (from !== 'framed' || to !== 'proof_ready')
          throw new AuditCorpusError('Only a transition from framed to proof_ready can bind the proof plan.');
        boundPlan = transition.proof_plan_sha256;
      }
    } else if (event.state_version !== stateVersion) {
      throw new AuditCorpusError(
        `Audit event ${event.sequence} must record the current state version ${stateVersion}.`,
      );
    }
    if (event.event_type === 'proof_receipt_recorded') {
      const parsed = localReceiptSchema.safeParse(payload);
      if (!parsed.success || state !== 'verifying')
        throw new AuditCorpusError(`Invalid local proof receipt at audit event ${event.sequence}.`);
      const receipt = parsed.data;
      if (receiptIds.has(receipt.receipt_id)) throw new AuditCorpusError('Duplicate local proof receipt id.');
      receiptIds.add(receipt.receipt_id);
      if (receipt.result === 'setup_failed') setupFailures++;
      else if (receipt.result !== 'passed') {
        gateFailures.set(receipt.gate_id, (gateFailures.get(receipt.gate_id) ?? 0) + 1);
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

export function createAuditCorpus(
  sessions: AuditCorpusSession[],
  digest: ProofDigest,
  limits: { maxBytes?: number; maxRecords?: number } = {},
) {
  const maxRecords = Math.min(limits.maxRecords ?? MAX_AUDIT_CORPUS_RECORDS, MAX_AUDIT_CORPUS_RECORDS);
  const maxBytes = Math.min(limits.maxBytes ?? MAX_AUDIT_CORPUS_BYTES, MAX_AUDIT_CORPUS_BYTES);
  // Each selected session needs at least one event, in addition to the manifest and seal.
  if (!(sessions.length + 2 <= maxRecords)) throw new AuditCorpusLimitError();
  let eventCount = 0;
  for (const session of sessions) {
    eventCount += session.events.length;
    if (eventCount + 2 > maxRecords) throw new AuditCorpusLimitError();
  }
  const ordered = [...sessions].sort((left, right) =>
    left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0,
  );
  if (ordered.length === 0 || new Set(ordered.map((session) => session.session_id)).size !== ordered.length) {
    throw new AuditCorpusError('Select at least one session, with no duplicate session ids.');
  }
  const summaries: ReturnType<typeof projectAuditSession>[] = [];
  const manifest = {
    record_type: 'manifest',
    schema_version: 'threadloop.audit-corpus/1',
    comparison_unit: 'session',
    sessions: summaries,
  };
  const seal = {
    record_type: 'seal',
    prefix_sha256: ZERO_AUDIT_HASH,
    session_count: ordered.length,
    event_count: eventCount,
  };
  // Reserve the complete seal with a fixed-width digest, the empty manifest, and their newlines.
  let remaining = maxBytes;
  function reserve(bytes: number) {
    remaining -= bytes;
    if (!(remaining >= 0)) throw new AuditCorpusLimitError();
  }
  reserve(Buffer.byteLength(canonicalJson(manifest)) + Buffer.byteLength(canonicalJson(seal)) + 2);
  const eventLines: string[] = [];
  for (const session of ordered) {
    for (const event of session.events) {
      if (event.json.length + session.session_id.length + event.sha256.length > remaining)
        throw new AuditCorpusLimitError();
      const line = canonicalJson({
        record_type: 'event',
        session_id: session.session_id,
        canonical_event: event.json,
        event_sha256: event.sha256,
      });
      reserve(Buffer.byteLength(line) + 1);
      eventLines.push(line);
    }
    const summary = projectAuditSession(session, digest);
    // Account for each summary inside the manifest array, including its separating comma.
    reserve(Buffer.byteLength(canonicalJson(summary)) + (summaries.length ? 1 : 0));
    summaries.push(summary);
  }
  const prefix = [canonicalJson(manifest), ...eventLines, ''].join('\n');
  seal.prefix_sha256 = hash.parse(digest(prefix));
  const content = prefix + canonicalJson(seal) + '\n';
  return { content, root: digest(content), manifest, session_count: ordered.length, event_count: eventCount };
}

/** Rebuilds the complete format from retained event bytes; no repository or database is consulted. */
export function verifyAuditCorpus(content: string, digest: ProofDigest, expectedRoot?: string) {
  try {
    if (!content.endsWith('\n')) throw new AuditCorpusError('Corpus must end with a newline and a complete seal.');
    if (expectedRoot !== undefined && hash.parse(expectedRoot) !== digest(content))
      throw new AuditCorpusError("Retained corpus root doesn't match.");
    const lines = content.slice(0, -1).split('\n');
    const manifestValue: unknown = JSON.parse(lines[0]!);
    if (
      manifestValue !== null &&
      typeof manifestValue === 'object' &&
      'sessions' in manifestValue &&
      Array.isArray(manifestValue.sessions) &&
      manifestValue.sessions.length > lines.length - 2
    )
      throw new AuditCorpusError('The manifest lists more sessions than there are retained event records.');
    const manifest = manifestSchema.parse(manifestValue);
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
      throw new AuditCorpusError("Corpus framing, projections, bytes, or seal don't match retained events.");
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
