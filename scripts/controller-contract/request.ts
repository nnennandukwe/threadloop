import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { validateShape, type ValidationResult } from '../workflow-graph/contracts.js';
import { actionIntentSchema, actionRequestSchema, type ActionRequest } from './contracts.js';
import { issue, requestIdentity, validateControllerInput, validateRequestInSnapshot } from './validation.js';

/** Binds a supplied choice; it neither selects that choice nor authorizes its execution. */
export function buildActionRequest(snapshot: unknown, intent: unknown): ValidationResult<ActionRequest> {
  const input = validateControllerInput(snapshot);
  if (!input.ok) return input;
  const proposal = validateShape(actionIntentSchema, intent);
  if (!proposal.ok) return proposal;
  const value = input.value;
  const choice = proposal.value;
  const action = value.compiled_graph.graph.required_actions.find((action) => action.id === choice.action_id);
  if (!action)
    return {
      ok: false,
      diagnostics: [issue('UNKNOWN_ACTION', '$.action_id', 'The action is not declared by the bound graph.')],
    };
  const deadlines = [
    choice.valid_until,
    value.observation.valid_until,
    ...value.receipts
      .filter((receipt) => choice.evidence_ids.includes(receipt.id))
      .map((receipt) => receipt.valid_until),
  ]
    .filter((deadline): deadline is string => deadline !== null)
    .sort();
  const request = {
    schema_version: '0.1',
    binding: value.binding,
    capability_catalog: 'threadloop.sdlc/0.1',
    action_id: action.id,
    capability: action.capability,
    actor: action.authority,
    transition_id: choice.transition_id,
    guard_ids: [...choice.guard_ids].sort(),
    inputs: [...choice.inputs].sort((left, right) => compare(left.role, right.role)),
    evidence_ids: [...choice.evidence_ids].sort(),
    constraints: { require_current_subject: true, lifecycle_mutation: false, valid_until: deadlines[0] ?? null },
    policy: { id: value.policy.id, digest: value.policy.digest },
    authorities: value.policy.rules.authorities,
    evidence_requirements: [...choice.evidence_requirements].sort((left, right) =>
      compare(canonicalJson(left), canonicalJson(right)),
    ),
    idempotency_key: requestIdentity(value.binding, action.id),
  };
  const parsed = validateShape(actionRequestSchema, { request, request_digest: sha256(canonicalJson(request)) });
  return parsed.ok ? validateRequestInSnapshot(value, parsed.value) : parsed;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
