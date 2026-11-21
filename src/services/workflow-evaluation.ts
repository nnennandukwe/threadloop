import type { ControllerInput } from 'threadloop-contracts/controller';
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
export function decideWorkflow(snapshot: RunSnapshot, observed: PhysicalObservation, at: string): DecisionReply {
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

export function applyObservedWorkflow(
  snapshot: RunSnapshot,
  proposal: DecisionReply,
  observed: PhysicalObservation,
  at: string,
): AppliedTransition {
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
  return evaluateApply(snapshot, proposal, at, () => observed);
}
