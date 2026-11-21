import { validateRequestInSnapshot, type ActionRequest, type ControllerInput } from 'threadloop-contracts/controller';
import { projectControllerExecution, executionAdmissionDigest, requestReference } from 'threadloop-contracts/execution';
import type { GaapBinding } from '../domain/gaap-binding.js';
import { ThreadloopError } from '../contracts/errors.js';
import { gaapObjectDigest } from '../domain/gaap-content.js';
import { workflowDigest } from '../domain/workflow-selection-types.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { selectWorkflowDecision } from '../domain/workflow-controller.js';
import type {
  AdmittedObservation,
  AppliedTransition,
  DecisionReply,
  PhysicalObservation,
  Receipt,
  RunSnapshot,
} from '../domain/workflow-run.js';
import { nextWorkflowHistory } from './workflow-history.js';
import { observeWorkflow } from './workflow-observation.js';
export { initialWorkflowHistory } from './workflow-history.js';
export { observeWorkflow } from './workflow-observation.js';

function stale(reason: string, message: string): never {
  throw new ThreadloopError('STATE_VERSION_CONFLICT', message, {
    details: { reason, hint: 'Run workflow decide again against the current run and subject.' },
  });
}
function allowedReceipts(snap: RunSnapshot, observed: PhysicalObservation, at: string): Receipt[] {
  const latest = new Map<string, AdmittedObservation>();
  const subject = canonicalJson(observed.subject),
    policy = canonicalJson(snap.view.policy);
  for (const batch of snap.observations) {
    if (
      batch.binding.workflow_run_id !== snap.view.workflow_run_id ||
      batch.binding.graph_digest !== snap.view.graph_digest ||
      canonicalJson(batch.binding.subject) !== subject ||
      canonicalJson(batch.workflow_policy) !== policy ||
      batch.branch !== observed.facts.repository?.branch
    )
      continue;
    if (batch.applicable_version !== null && batch.applicable_version !== snap.view.state_version) continue;
    if (batch.stream.kind === 'signed-review' && snap.product_pr?.number !== batch.stream.pr) continue;
    if (
      batch.stream.kind === 'signed-instruction' &&
      (batch.stream.version !== snap.view.state_version ||
        batch.applicable_version !== snap.view.state_version ||
        batch.stream.pr === snap.product_pr?.number)
    )
      continue;
    const enrolled = snap.genesis.source_policies[batch.stream.kind];
    if (!enrolled || canonicalJson(enrolled) !== canonicalJson(batch.evidence_policy))
      throw new ThreadloopError(
        'STATE_CORRUPTED',
        'A retained observation has a different verification policy from its enrolled source.',
      );
    const key = canonicalJson(batch.stream),
      previous = latest.get(key);
    const measured = Date.parse(batch.measured_at);
    if (!Number.isFinite(measured))
      throw new ThreadloopError('STATE_CORRUPTED', 'A retained observation has an invalid measurement time.');
    if (previous && Date.parse(previous.measured_at) === measured && previous.source_id !== batch.source_id)
      throw new ThreadloopError(
        'STATE_CORRUPTED',
        'Two observations in the same stream have a conflicting measurement time.',
      );
    if (!previous || Date.parse(previous.measured_at) < measured) latest.set(key, batch);
  }
  const instant = Date.parse(at);
  return [...latest.values()]
    .filter(
      (batch) =>
        Date.parse(batch.measured_at) <= instant &&
        (batch.valid_until === null || instant < Date.parse(batch.valid_until)),
    )
    .flatMap((batch) => batch.receipts)
    .sort((a, b) => a.sequence - b.sequence);
}
function humanCapabilities(snap: RunSnapshot): ControllerInput['available_capabilities'] {
  const g = snap.genesis;
  if (!g.sources?.github) return [];
  const actions: ControllerInput['available_capabilities'] = [];
  for (const action of g.compiled.graph.required_actions) {
    if (action.authority !== 'human') continue;
    const enrollment =
      action.capability === 'block_run' || action.capability === 'recover_run'
        ? 'signed-instruction'
        : action.capability === 'approve_change' || action.capability === 'merge_change'
          ? 'signed-review'
          : null;
    if (!enrollment || !g.source_policies[enrollment]) continue;
    if (!actions.some((available) => available.capability === action.capability))
      actions.push({ actor: 'human', capability: action.capability });
  }
  return actions;
}
type ExecutionInput = Pick<ControllerInput, 'execution' | 'existing_requests' | 'invalidated_claims'>;
export function workflowControllerInput(
  snapshot: RunSnapshot,
  observed: PhysicalObservation,
  at: string,
  previousExecution?: ExecutionInput,
): ControllerInput {
  const g = snapshot.genesis,
    v = snapshot.view;
  const input: ControllerInput = {
    schema_version: '0.1',
    compiled_graph: g.compiled,
    binding: {
      workflow_run_id: v.workflow_run_id,
      graph_schema_version: v.graph_schema_version,
      graph_digest: v.graph_digest,
      source_state: v.state,
      state_version: v.state_version,
      subject: observed.subject,
    },
    policy: g.policy,
    history: snapshot.history,
    observation: observed.facts,
    available_capabilities: humanCapabilities(snapshot),
    receipts: allowedReceipts(snapshot, observed, at),
    execution: { status: 'idle' },
    invalidated_claims: [],
    existing_requests: [],
    evaluation_time: at,
  };
  if (!g.gaap) return input;
  const managed = snapshot.managed_execution;
  if (!managed)
    throw new ThreadloopError('STATE_CORRUPTED', 'The managed Workflow Run has no verified execution history.');
  input.available_capabilities.push({
    actor: 'executor',
    capability: g.gaap.adapter.mapping_policy.policy.action_capability,
  });
  if (previousExecution) return { ...input, ...previousExecution };
  input.existing_requests = [...managed.existing_requests];
  input.invalidated_claims = [...managed.invalidated_claims];
  const child = managed.active?.child;
  if (!child) return input;
  const authority = new Set(child.authority);
  authority.add(
    executionAdmissionDigest({ kind: 'projection', execution_digest: child.journal.execution_digest, snapshot: input }),
  );
  const projected = projectControllerExecution(child.journal, input, { isAdmitted: (digest) => authority.has(digest) });
  if (!projected.ok)
    throw new ThreadloopError(
      'TRANSITION_GUARD_FAILED',
      "The runtime can't project its execution journal onto this observation.",
      {
        details: {
          reason: 'execution_projection_unavailable',
          diagnostics: projected.diagnostics,
          hint: 'Inspect and reconcile the outstanding managed execution.',
        },
      },
    );
  return { ...input, ...projected.value };
}
export function workflowGaapBinding(
  snapshot: RunSnapshot,
  input: ControllerInput,
  request: ActionRequest,
): GaapBinding {
  const g = snapshot.genesis,
    enrollment = g.gaap;
  const current = selectWorkflowDecision(input);
  if (
    !enrollment ||
    input.binding.workflow_run_id !== g.run_id ||
    input.binding.graph_digest !== g.compiled.graph_digest ||
    canonicalJson(input.policy) !== canonicalJson(g.policy) ||
    !current.ok ||
    current.value.decision.outcome !== 'engineering_action_required' ||
    canonicalJson(current.value.decision.action_request) !== canonicalJson(request) ||
    !validateRequestInSnapshot(input, request).ok ||
    request.request.capability !== enrollment.adapter.mapping_policy.policy.action_capability
  )
    stale('managed_action_unavailable', 'The enrolled adapter requires its exact current engineering action.');
  const { mapping_policy, parameters, executor, lease_ms, execution_policy } = enrollment.adapter;
  if (parameters.approval_context.some((item) => item.subject_digest !== input.binding.subject.content_digest))
    stale('managed_approval_mismatch', 'The enrolled executor approval context targets a different action subject.');
  const families = new Set(request.request.evidence_requirements.map((item) => item.family));
  const mappings = mapping_policy.policy.evidence_mapping.filter((item) => families.has(item.family));
  const wanted = [...new Set(mappings.flatMap((item) => item.evidence_types))].sort();
  if (
    mappings.length !== families.size ||
    canonicalJson(wanted) !== canonicalJson([...parameters.required_verification.evidence_types].sort())
  )
    stale('managed_mapping_mismatch', 'The enrolled verification mapping must cover every selected evidence family.');
  const rules = {
    request: requestReference(request),
    workflow_policy: { id: g.policy.id, digest: g.policy.digest },
    retry_safety: execution_policy.retry_safety,
    max_attempts: execution_policy.max_attempts,
  };
  return {
    schema_version: 'threadloop.gaap-binding/1',
    snapshot: input,
    action_request: request,
    execution_policy: { id: execution_policy.id, rules, digest: workflowDigest(rules) },
    mapping_policy,
    parameters,
    executor,
    lease_ms,
  };
}
export function decideWorkflow(snapshot: RunSnapshot, observed: PhysicalObservation, at: string): DecisionReply {
  const v = snapshot.view;
  const input = workflowControllerInput(snapshot, observed, at);
  const result = selectWorkflowDecision(input);
  if (!result.ok)
    throw new ThreadloopError('STATE_CORRUPTED', 'The Workflow Run input violates its controller contract.', {
      details: {
        reason: 'invalid_controller_input',
        diagnostics: result.diagnostics,
        hint: 'Inspect the run and restore any damaged binding or evidence.',
      },
    });
  const decision = result.value;
  return {
    controller_decision: decision,
    expectation: {
      workflow_run_id: v.workflow_run_id,
      graph_schema_version: v.graph_schema_version,
      graph_digest: v.graph_digest,
      policy: v.policy,
      state: v.state,
      state_version: v.state_version,
      history_digest: v.history_digest,
      ...(snapshot.managed_execution
        ? {
            execution_revision: snapshot.managed_execution.revision,
            execution_digest: snapshot.managed_execution.digest,
          }
        : {}),
      evidence_revision: v.evidence_revision,
      subject: observed.subject,
      evaluation_time: at,
      input_digest: decision.decision.input_digest,
      decision_digest: decision.decision_digest,
    },
  };
}
function evaluateApply(
  snapshot: RunSnapshot,
  proposal: DecisionReply,
  now: string,
  observe: () => PhysicalObservation,
): AppliedTransition {
  if (proposal.expectation.evaluation_time > now)
    stale('future_decision', 'The decision timestamp is later than the host clock.');
  const originalObservation = observe();
  const original = decideWorkflow(snapshot, originalObservation, proposal.expectation.evaluation_time);
  if (canonicalJson(original) !== canonicalJson(proposal))
    stale('decision_changed', 'The decision no longer matches the observed run, subject or evidence.');
  if (original.controller_decision.decision.outcome !== 'transition_available')
    throw new ThreadloopError('TRANSITION_GUARD_FAILED', 'Only an available graph transition can advance this run.', {
      details: { reason: 'transition_unavailable', hint: 'Follow the current decision and reevaluate.' },
    });
  const observed = observe();
  if (canonicalJson(observed.facts) !== canonicalJson(originalObservation.facts))
    stale('subject_changed', 'The physical subject changed during the transition check.');
  const fresh = decideWorkflow(snapshot, observed, now).controller_decision;
  const previous = original.controller_decision.decision;
  const selected = fresh.decision;
  if (
    selected.outcome !== 'transition_available' ||
    selected.transition_id !== previous.transition_id ||
    selected.target_state !== previous.target_state ||
    canonicalJson(selected.checks) !== canonicalJson(previous.checks)
  )
    stale('transition_authority_changed', 'The selected transition or its current evidence has changed.');
  const witnesses = new Set(selected.checks.flatMap((check) => check.evidence_ids));
  if (
    snapshot.observations.some(
      (batch) =>
        batch.authorized_edge !== null &&
        batch.authorized_edge !== selected.transition_id &&
        batch.receipts.some((receipt) => witnesses.has(receipt.id)),
    )
  )
    stale('instruction_edge_mismatch', 'The human instruction authorizes a different transition.');
  const next = nextWorkflowHistory(snapshot, selected, observed);
  return {
    selected,
    fresh_decision_digest: fresh.decision_digest,
    observed,
    next_history: next.history,
    implementation_manifest: next.implementation_manifest,
  };
}

export function applyWorkflow(snapshot: RunSnapshot, proposal: DecisionReply, now: string): AppliedTransition {
  return evaluateApply(snapshot, proposal, now, () => observeWorkflow(snapshot));
}

export function assertWorkflowObservation(snapshot: RunSnapshot, observed: PhysicalObservation): void {
  const { id, ...facts } = observed.facts;
  const physical = observed.physical;
  if (
    facts.status !== 'verified' ||
    !physical ||
    !facts.repository ||
    observed.subject.kind !== 'repository' ||
    facts.state_version !== snapshot.view.state_version ||
    id !== workflowDigest(facts) ||
    canonicalJson(facts.subject) !== canonicalJson(observed.subject) ||
    observed.subject.repository_id !== snapshot.genesis.setup.repository_id ||
    observed.subject.revision !== physical.revision ||
    observed.subject.content_digest !== physical.digest ||
    gaapObjectDigest(physical.manifest) !== 'sha256:' + physical.digest ||
    facts.repository.clean !== physical.clean ||
    facts.repository.branch !== (physical.branch || null) ||
    (snapshot.genesis.sources?.github && observed.origin !== snapshot.genesis.setup.repository_id)
  )
    throw new ThreadloopError(
      'STATE_CORRUPTED',
      'The retained transition observation disagrees with the physical subject.',
    );
}

export function applyObservedWorkflow(
  snapshot: RunSnapshot,
  proposal: DecisionReply,
  observed: PhysicalObservation,
  at: string,
): AppliedTransition {
  assertWorkflowObservation(snapshot, observed);
  return evaluateApply(snapshot, proposal, at, () => observed);
}
