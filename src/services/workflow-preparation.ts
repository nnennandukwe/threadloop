import { workflowDeadline } from '../domain/validation.js';
import { z } from 'zod';
import { readGaapFile } from '../adapters/fs/gaap-files.js';
import { StateCorruptedError, ThreadloopError } from '../contracts/errors.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { parseGaapJson } from '../domain/gaap-json.js';
import type {
  Instruction,
  PhysicalObservation,
  Preparation,
  PrepareTarget,
  RunSnapshot,
} from '../domain/workflow-run.js';

const reason = z.string().trim().min(1).max(4096);
const edgeId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const instructionSchema = z.discriminatedUnion('purpose', [
  z.strictObject({ purpose: z.literal('request_stop'), reason }),
  z.strictObject({
    purpose: z.literal('block_run'),
    transition_id: edgeId,
    reason,
    stop_code: z.string().min(1).max(256),
    evidence_ref: reason,
    recovery: reason,
    request_stop: z.boolean(),
  }),
  z.strictObject({ purpose: z.literal('recover_run'), transition_id: edgeId, reason }),
]);

export function readWorkflowInstruction(path: string): Instruction {
  const parsed = instructionSchema.safeParse(parseGaapJson(readGaapFile(path, 32 * 1024)));
  if (!parsed.success)
    throw new ThreadloopError(
      'INVALID_ARGUMENT',
      'Supply one stop, block or recovery instruction with its required fields.',
    );
  return parsed.data;
}

function refuse(reason: string, message: string): never {
  throw new ThreadloopError('TRANSITION_GUARD_FAILED', message, {
    details: { reason, hint: 'Inspect the bound run, enrolled sensor and target before preparing new evidence.' },
  });
}

function checkInstruction(snapshot: RunSnapshot, instruction: Instruction) {
  const graph = snapshot.genesis.compiled.graph;
  const from = graph.states.find((state) => state.id === snapshot.view.state);
  if (from?.kind === 'terminal') refuse('terminal_run', "A terminal run can't accept a new instruction.");
  if (instruction.purpose === 'request_stop') {
    if (from?.kind !== 'active') refuse('inactive_run', 'A stop request requires an active state.');
    return;
  }
  const edge = graph.transitions.find(
    (item) => item.id === instruction.transition_id && item.from === snapshot.view.state,
  );
  const to = graph.states.find((state) => state.id === edge?.to);
  const guards = graph.guards.filter((guard) => edge?.guard_refs.includes(guard.id));
  if (instruction.purpose === 'block_run') {
    if (from?.kind !== 'active' || to?.kind !== 'suspended' || !guards.some((g) => g.capability === 'block_evidence'))
      refuse('invalid_block_edge', 'The instruction must name a guarded suspension edge from the current state.');
  } else if (
    from?.kind !== 'suspended' ||
    to?.id !== snapshot.history.prior_state ||
    !guards.some((g) => g.capability === 'human_approval' && g.parameters.scope === 'recovery') ||
    !guards.some((g) => g.capability === 'recorded_prior_state' && g.parameters.state === to?.id)
  ) {
    refuse('invalid_recovery_edge', 'Recovery must name the authorized return edge to the recorded prior state.');
  }
}

export function prepareSensorObservation(
  snapshot: RunSnapshot,
  observed: PhysicalObservation,
  target: PrepareTarget,
  id: string,
  now: string,
): Preparation {
  const { genesis } = snapshot;
  if (
    observed.facts.status !== 'verified' ||
    observed.subject.kind !== 'repository' ||
    !observed.physical?.clean ||
    observed.physical.branch !== genesis.baseline_branch ||
    observed.origin !== genesis.baseline.repository_id
  )
    refuse('unavailable_subject', 'The enrolled repository must be clean and on the bound branch.');
  return buildPreparation(snapshot, observed.subject, target, id, now, observed.facts.valid_until);
}

export function validateWorkflowPreparation(snapshot: RunSnapshot, prepared: Preparation): void {
  const subject = prepared.binding.subject;
  if (
    subject.kind !== 'repository' ||
    subject.repository_id !== snapshot.genesis.baseline.repository_id ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(subject.revision) ||
    !/^[a-f0-9]{64}$/.test(subject.content_digest)
  )
    throw new StateCorruptedError('The retained preparation contains an invalid repository subject.');
  const rebuilt = buildPreparation(
    snapshot,
    subject,
    prepared.target,
    prepared.prepared_id,
    prepared.prepared_at,
    prepared.observation_valid_until ?? null,
  );
  if (canonicalJson(rebuilt) !== canonicalJson(prepared))
    throw new StateCorruptedError('The retained preparation differs from its enrolled target and policy.');
}

function buildPreparation(
  snapshot: RunSnapshot,
  subject: Preparation['binding']['subject'],
  target: PrepareTarget,
  id: string,
  now: string,
  observationDeadline: string | null,
): Preparation {
  const { genesis, view } = snapshot;
  const github = genesis.sources?.github;
  const plan = genesis.proof_plan;
  const evidencePolicy = genesis.source_policies[target.kind];
  if (!github || !plan || !evidencePolicy)
    refuse('unavailable_sensor', 'The run has no enrolled sensor for this evidence.');
  const binding = {
    workflow_run_id: view.workflow_run_id,
    graph_schema_version: view.graph_schema_version,
    graph_digest: view.graph_digest,
    source_state: view.state,
    state_version: view.state_version,
    subject,
  };
  const deadline = workflowDeadline(now, github.preparation_ttl_ms);
  if (!deadline) {
    throw new ThreadloopError(
      'TRANSITION_GUARD_FAILED',
      'The preparation deadline exceeds the Workflow Run timestamp range.',
      {
        details: {
          reason: 'invalid_workflow_deadline',
          hint: 'Use a new run with a shorter preparation lifetime.',
        },
      },
    );
  }
  const validUntil = observationDeadline && observationDeadline < deadline ? observationDeadline : deadline;
  if (validUntil <= now) refuse('stale_observation', 'The current observation has expired.');
  const common = {
    prepared_id: id,
    prepared_at: now,
    valid_until: validUntil,
    binding,
    branch: genesis.baseline_branch,
    ...(observationDeadline ? { observation_valid_until: observationDeadline } : {}),
    workflow_policy: view.policy,
    evidence_policy: evidencePolicy,
  };
  const sensor = { session_id: binding.workflow_run_id, plan_sha256: plan.sha256, prepared_receipt_id: id };
  if (target.kind === 'signed-gate') {
    const gate = plan.plan.gates.find((item) => item.id === target.gate_id);
    if (!gate || !genesis.policy.rules.independent_gate_ids.includes(gate.id))
      refuse('undeclared_gate', 'Choose an independent gate declared in the bound proof plan.');
    return {
      ...common,
      target,
      pull_request: null,
      manifest_json: null,
      sensor_inputs: { ...sensor, gate_id: gate.id, gate_json: canonicalJson(gate) },
    };
  }
  const pull = {
    number: target.pr,
    url: genesis.baseline.repository_id + '/pull/' + target.pr,
    base_ref: github.base_ref,
  };
  const sensor_inputs = { ...sensor, pull_request_number: target.pr };
  if (target.kind === 'signed-review') {
    if (snapshot.product_pr && canonicalJson(snapshot.product_pr) !== canonicalJson(pull))
      refuse('different_product_pr', 'The run is already bound to another product pull request.');
    return { ...common, target, pull_request: pull, manifest_json: null, sensor_inputs };
  }
  if (snapshot.product_pr?.number === target.pr)
    refuse('product_pr_instruction', 'Use a separate authorization pull request for an explicit instruction.');
  checkInstruction(snapshot, target.instruction);
  const manifest_json = canonicalJson({
    schema_version: 'threadloop.workflow-instruction/1',
    ...common,
    pull_request: pull,
    enrolled_human: github.human_node_id,
    prior_state: snapshot.history.prior_state,
    instruction: target.instruction,
    authorization: 'Approving this exact commit authorizes only the instruction, run and state version in this file.',
  });
  return { ...common, target, pull_request: pull, manifest_json, sensor_inputs };
}
