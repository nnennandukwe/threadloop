import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { same } from '../controller-contract/validation.js';
import type { ValidationResult } from '../workflow-graph/contracts.js';
import { canonicalExecutorJson, invalid, validateJsonValue } from './codec.js';
import type { GaapEvent, GaapReceipt, GaapRequest } from './gaap-types.js';

const ajv = new Ajv2020({ strict: true, allErrors: false });
ajv.addFormat('uint64', { type: 'number', validate: (value: number) => Number.isSafeInteger(value) && value >= 0 });
const upstream = new URL('../../docs/contracts/executor-v0.1/upstream/gaap/', import.meta.url);
const requestSchema = ajv.compile<GaapRequest>(
  JSON.parse(readFileSync(new URL('agent-run-request.schema.json', upstream), 'utf8')) as object,
);
const receiptSchema = ajv.compile<GaapReceipt>(
  JSON.parse(readFileSync(new URL('terminal-run-receipt.schema.json', upstream), 'utf8')) as object,
);

function hasBlankText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length === 0;
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasBlankText);
  return false;
}

export function gaapDigest(value: unknown): ValidationResult<string> {
  const canonical = canonicalExecutorJson(value);
  return canonical.ok ? { ok: true, value: 'sha256:' + sha256(canonical.value) } : canonical;
}

export function validateGaapRequest(value: unknown): ValidationResult<GaapRequest> {
  const bounded = validateJsonValue(value);
  if (!bounded.ok) return bounded;
  if (!requestSchema(value)) return invalid('GAAP_SCHEMA_INVALID', ajv.errorsText(requestSchema.errors));
  if (hasBlankText(value))
    return invalid('GAAP_SCHEMA_INVALID', 'GAAP text values must contain non-whitespace characters.');
  const policies = new Set<string>();
  for (const policy of value.policies) {
    const canonical = canonicalExecutorJson(policy);
    if (!canonical.ok) return canonical;
    policies.add(canonical.value);
  }
  if (
    policies.size !== value.policies.length ||
    new Set(value.required_verification.evidence_types).size !== value.required_verification.evidence_types.length
  )
    return invalid('GAAP_SCHEMA_INVALID', 'GAAP policy identities and required evidence types must be unique.');
  if (
    value.approval_context.some(
      (approval) => approval.subject_digest !== value.subject.digest || approval.evidence.evidence_type !== 'approval',
    )
  )
    return invalid('GAAP_APPROVAL_MISMATCH', 'GAAP request approvals must bind the exact initial subject.');
  return { ok: true, value: structuredClone(value) };
}

/** Consistency checking of the pinned ledger contract; never policy evaluation or provenance verification. */
export function validateGaapReceipt(value: unknown, requestValue: unknown): ValidationResult<GaapReceipt> {
  const request = validateGaapRequest(requestValue);
  if (!request.ok) return request;
  const bounded = validateJsonValue(value);
  if (!bounded.ok) return bounded;
  if (!receiptSchema(value)) return invalid('GAAP_SCHEMA_INVALID', ajv.errorsText(receiptSchema.errors));
  if (hasBlankText(value))
    return invalid('GAAP_SCHEMA_INVALID', 'GAAP receipt text values must contain non-whitespace characters.');
  const body = value.body;
  const digest = gaapDigest(body);
  if (!digest.ok) return digest;
  if (digest.value !== value.receipt_digest)
    return invalid('GAAP_DIGEST_MISMATCH', 'GAAP receipt body differs from its digest.');
  const requestDigest = gaapDigest(request.value);
  if (!requestDigest.ok) return requestDigest;
  if (
    body.request_id !== request.value.request_id ||
    body.run_id !== request.value.run_id ||
    body.request_digest !== requestDigest.value ||
    body.initial_subject_digest !== request.value.subject.digest
  )
    return invalid('GAAP_REQUEST_MISMATCH', 'GAAP receipt must bind the exact mapped request and initial subject.');
  if (!['completed', 'blocked', 'failed', 'interrupted'].includes(body.terminal_status))
    return invalid('GAAP_NONTERMINAL_RESULT', 'A one-shot result must contain a terminal receipt.');
  const terminal = (state: string) => ['completed', 'blocked', 'failed', 'interrupted'].includes(state);
  const routes: Record<string, readonly string[]> = {
    accepted: ['planning'],
    planning: ['awaiting_authority', 'executing'],
    awaiting_authority: ['planning', 'executing'],
    executing: ['awaiting_authority', 'verifying'],
    verifying: ['executing', 'completed'],
  };
  let state: GaapReceipt['body']['terminal_status'] = 'accepted';
  let subject = body.initial_subject_digest;
  let terminalReason: string | null = null;
  let verifiedAt = 0;
  let completionAt = 0;
  let completionSubject: string | null = null;
  let completionEffect: string | null = null;
  let interruptionSeen = false;
  let usage = { cost_micros: 0, elapsed_ms: 0, model_tokens: 0, tool_calls: 0 };
  let usageSeen = false;
  const decisions = new Map<string, Extract<GaapEvent, { event_type: 'protected_effect_decision' }>>();
  const fail = (message: string) => invalid('GAAP_LEDGER_INVALID', message);
  for (const [index, event] of body.events.entries()) {
    if (event.sequence !== index + 1 || terminal(state))
      return fail('Ledger sequences must be contiguous and stop at the terminal transition.');
    switch (event.event_type) {
      case 'status_transition':
        if (
          event.from !== state ||
          !(routes[state]?.includes(event.to) || ['blocked', 'failed', 'interrupted'].includes(event.to))
        )
          return fail('Ledger contains an invalid lifecycle transition.');
        state = event.to;
        if (terminal(state)) terminalReason = event.reason;
        break;
      case 'plan_recorded':
        break;
      case 'approval_recorded':
        if (event.approval.evidence.evidence_type !== 'approval')
          return fail('Approval records require approval evidence.');
        break;
      case 'protected_effect_decision':
        if (decisions.has(event.decision_id) || event.subject_digest !== subject)
          return fail('Decisions must have unique identities and bind the current subject.');
        decisions.set(event.decision_id, event);
        if (
          event.gate === 'workflow' &&
          event.subject_digest === subject &&
          event.decision.outcome === 'allow' &&
          event.decision.code === 'workflow.completion_authorized'
        ) {
          completionAt = event.sequence;
          completionSubject = event.subject_digest;
          completionEffect = event.protected_effect_digest;
        }
        break;
      case 'tool_execution':
      case 'mutation': {
        if (state !== 'executing') return fail('Tool execution and mutation events require the executing state.');
        const decision = decisions.get(event.decision_id);
        if (
          !decision ||
          decision.decision.outcome !== 'allow' ||
          decision.subject_digest !== subject ||
          decision.protected_effect_digest !== event.protected_effect_digest ||
          decision.gate !== (event.event_type === 'mutation' ? 'workflow' : 'permission')
        )
          return fail(
            'Every observed effect requires its earlier matching allow decision; ask and block grant nothing.',
          );
        if (event.event_type === 'tool_execution') {
          if (event.capability_digest !== request.value.requested_capability.digest)
            return fail('Tool execution capability differs from the request.');
          if (!event.evidence.some((entry) => entry.evidence_type === 'tool_execution'))
            return fail('Tool execution requires tool_execution evidence.');
        } else {
          if (event.before_subject_digest !== subject)
            return fail('Mutation chain must start from the latest subject.');
          if (!event.evidence.some((entry) => entry.evidence_type === 'artifact'))
            return fail('Mutation requires artifact evidence.');
          subject = event.after_subject_digest;
          verifiedAt = 0;
        }
        break;
      }
      case 'verification':
        if (state !== 'verifying') return fail('Verification events require the verifying state.');
        if (event.verdict === 'PASS') {
          if (
            event.verifier_id === event.implementer_id ||
            !request.value.required_verification.evidence_types.every((type) =>
              event.evidence.some((evidence) => evidence.evidence_type === type),
            )
          )
            return fail('Passing verification requires a different actor and every requested evidence type.');
          if (event.subject_digest === subject) verifiedAt = event.sequence;
        }
        break;
      case 'usage':
        if ((Object.keys(usage) as (keyof typeof usage)[]).some((key) => event.usage[key] < usage[key]))
          return fail('Resource usage must be cumulative and monotonic.');
        usage = event.usage;
        usageSeen = true;
        break;
      case 'interruption':
        if (event.evidence.evidence_type !== 'interruption')
          return fail('Interruption records require interruption evidence.');
        interruptionSeen = true;
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }
  if (
    state !== body.terminal_status ||
    terminalReason !== body.terminal_reason ||
    subject !== body.resulting_subject_digest ||
    !usageSeen ||
    !same(usage, body.usage)
  )
    return fail('Terminal status and reason, resulting subject, and final usage must agree with the retained ledger.');
  if (body.terminal_status === 'interrupted' && !interruptionSeen)
    return fail('Interrupted receipts require interruption evidence.');
  if (body.terminal_status === 'completed') {
    const budget = request.value.resource_budget;
    if (
      verifiedAt === 0 ||
      completionAt <= verifiedAt ||
      completionSubject !== subject ||
      completionEffect !== subject ||
      usage.cost_micros > budget.max_cost_micros ||
      usage.elapsed_ms > budget.max_elapsed_ms ||
      usage.model_tokens > budget.max_model_tokens ||
      usage.tool_calls > budget.max_tool_calls
    )
      return fail(
        'Completion requires latest-subject independent verification, later exact-subject completion authorization, and usage within budget.',
      );
  } else if (completionAt > 0) return fail('A completion-authorized receipt must terminate as completed.');
  return { ok: true, value: structuredClone(value) };
}
