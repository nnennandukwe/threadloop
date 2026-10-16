import type { GaapEvent } from 'threadloop-contracts/executor';
import { canonicalGaapJson, GaapEvidenceError } from './gaap-json.js';
import { gaapObjectDigest } from './gaap-content.js';
import type { GaapEffect, GaapStatement } from './gaap-types.js';

const same = (left: unknown, right: unknown) => canonicalGaapJson(left) === canonicalGaapJson(right);
const assert = (valid: boolean, message: string): void => {
  if (!valid) throw new GaapEvidenceError('attestation.effects', message);
};
type Decision = Extract<GaapEvent, { event_type: 'protected_effect_decision' }>;

/** Checks the selected v1 producer's effect contract in addition to the frozen ThreadLoop ledger mapping. */
export function verifyGaapEffects(statement: GaapStatement): void {
  const predicate = statement.predicate;
  const events = predicate.receipt.body.events;
  const decisions = events.filter((event): event is Decision => event.event_type === 'protected_effect_decision');
  const order = [
    ...new Set(
      decisions
        .filter(
          (event) =>
            !(
              event.gate === 'workflow' &&
              event.protected_effect_digest === event.subject_digest &&
              [
                'workflow.completion_authorized',
                'workflow.mutation_not_authorized',
                'workflow.verification_failed',
              ].includes(event.decision.code)
            ),
        )
        .map((event) => event.protected_effect_digest),
    ),
  ];
  assert(order.length === predicate.effects.length, 'Every ledger effect requires one signed request/result pair.');
  const ids = new Set<string>();
  let current = predicate.request.subject.digest;
  const sums = { cost_micros: 0, elapsed_ms: 0, model_tokens: 0, tool_calls: 0 };
  for (const [index, effect] of predicate.effects.entries()) {
    const { request: request, result } = effect;
    const body = result.body;
    const digest = gaapObjectDigest(request);
    assert(
      order[index] === digest &&
        !ids.has(request.effect_id) &&
        request.effect_sequence === index + 1 &&
        request.subject.digest === current,
      'Effects must retain exact order, unique identities and the latest admitted subject.',
    );
    ids.add(request.effect_id);
    verifyEffectIdentity(statement, effect, digest);
    verifyEffectOutcome(effect);
    const selected = decisions.find((event) => event.decision_id === body.decision.decision_id);
    assert(
      selected !== undefined &&
        same(
          {
            decision_id: selected.decision_id,
            effect_request_digest: selected.protected_effect_digest,
            gate: selected.gate,
            subject_digest: selected.subject_digest,
            decision: selected.decision,
          },
          body.decision,
        ),
      'The effect result requires its exact retained gate decision.',
    );
    const attempted = !['denied', 'awaiting_authority'].includes(body.execution_status);
    const executions = events.filter(
      (event) => event.event_type === 'tool_execution' && event.protected_effect_digest === digest,
    );
    assert(
      executions.length === (attempted ? 1 : 0),
      'The ledger must record exactly one execution for each attempted effect.',
    );
    if (attempted) {
      const execution = executions[0];
      assert(execution?.event_type === 'tool_execution', 'An attempted effect needs retained execution evidence.');
      if (execution?.event_type !== 'tool_execution')
        throw new GaapEvidenceError('attestation.effects', 'Missing execution record.');
      assert(
        execution.action_digest === digest &&
          execution.capability_digest === request.capability.digest &&
          execution.decision_id === body.decision.decision_id &&
          execution.evidence.some(
            (entry) => entry.evidence_type === 'tool_execution' && entry.digest === result.result_digest,
          ),
        'Execution must bind the exact action, capability, decision and result.',
      );
      const related = decisions.filter((event) => event.protected_effect_digest === digest);
      assert(
        related.every((event) => event.subject_digest === request.subject.digest && event.decision.outcome === 'allow'),
        'A refusing or stale-subject gate cannot admit execution.',
      );
      for (const gate of [
        'permission',
        'tool_trust',
        'runtime',
        ...(request.expected_effect_class === 'mutation' ? ['workflow'] : []),
      ]) {
        assert(
          related.some(
            (event) =>
              event.gate === gate &&
              event.sequence < execution.sequence &&
              (gate !== 'workflow' || event.decision.code === 'workflow.mutation_authorized'),
          ),
          'Every required gate must allow the exact effect before dispatch.',
        );
      }
    }
    const mutations = events.filter(
      (event) => event.event_type === 'mutation' && event.protected_effect_digest === digest,
    );
    const expected =
      attempted && request.expected_effect_class === 'mutation' && body.observed_post_effect_subject !== null;
    assert(
      mutations.length === (expected ? 1 : 0),
      'Mutation observations must agree with the effect class and known outcome.',
    );
    const mutation = mutations[0];
    if (mutation?.event_type === 'mutation') {
      assert(
        mutation.before_subject_digest === current &&
          mutation.after_subject_digest === body.observed_post_effect_subject?.digest,
        'The mutation chain must match the effect subject observations.',
      );
      current = mutation.after_subject_digest;
    }
    for (const key of Object.keys(sums) as Array<keyof typeof sums>) {
      sums[key] += body.usage[key];
      assert(
        Number.isSafeInteger(sums[key]) && sums[key] <= predicate.receipt.body.usage[key],
        'Run usage must include every protected-effect attempt without overflow.',
      );
    }
    assert(
      predicate.receipt.body.terminal_status !== 'completed' || body.execution_status === 'executed',
      'Completion cannot hide an unsuccessful or unknown effect.',
    );
  }
  assert(
    current === predicate.receipt.body.resulting_subject_digest,
    'Effect observations must end at the retained ledger subject.',
  );
  if (predicate.receipt.body.terminal_status === 'completed') {
    const completions = decisions.filter(
      (event) =>
        event.gate === 'workflow' &&
        event.decision.code === 'workflow.completion_authorized' &&
        event.decision.outcome === 'allow',
    );
    assert(
      completions.every((event) => event.protected_effect_digest === event.subject_digest),
      'The selected GAAP v1 producer requires completion to bind its verified subject as the completion effect.',
    );
  }
}

function verifyEffectIdentity(statement: GaapStatement, effect: GaapEffect, digest: string): void {
  const predicate = statement.predicate,
    request = effect.request,
    body = effect.result.body;
  assert(
    request.agent_run_request_digest === gaapObjectDigest(predicate.request) &&
      request.run_id === predicate.request.run_id &&
      same(request.capability, predicate.request.requested_capability) &&
      same(request.policies, predicate.request.policies) &&
      request.resource_budget_digest === gaapObjectDigest(predicate.request.resource_budget),
    'Every effect must bind the entire parent request, capability, policies and budget.',
  );
  const operation = request.normalized_operation.split('.');
  assert(
    operation.length >= 2 &&
      operation[0] === request.operation_family &&
      operation.every((segment) => /^[a-z][a-z0-9_]*$/.test(segment)),
    'Operation names require their declared family and lower-snake segments.',
  );
  assert(
    new Set(request.input_metadata.map((entry) => entry.name)).size === request.input_metadata.length &&
      request.input_metadata.every((entry) => [...entry.name].length <= 64 && [...entry.value].length <= 256),
    'Effect metadata requires unique bounded names and values.',
  );
  assert(
    new Set(request.approval_context.map((entry) => entry.approval_id)).size === request.approval_context.length &&
      request.approval_context.every(
        (entry) => entry.subject_digest === request.subject.digest && entry.evidence.evidence_type === 'approval',
      ),
    'Effect approvals must be unique and bind the exact effect subject.',
  );
  for (const scope of request.requested_scopes) {
    if (scope.scope_type === 'filesystem')
      assert(
        Array.isArray(scope.access) && scope.access.length > 0 && new Set(scope.access).size === scope.access.length,
        'Filesystem access classes must be unique.',
      );
    if (scope.scope_type === 'network')
      assert(
        typeof scope.host === 'string' &&
          !scope.host.includes('://') &&
          !/\p{White_Space}/u.test(scope.host) &&
          typeof scope.port === 'number' &&
          scope.port > 0,
        'Network scopes require a host without a scheme and a nonzero port.',
      );
  }
  for (const subject of [
    request.subject,
    body.observed_pre_effect_subject,
    ...(body.observed_post_effect_subject ? [body.observed_post_effect_subject] : []),
  ])
    assert(
      subject.kind === predicate.request.subject.kind && subject.locator === predicate.request.subject.locator,
      'Every effect observation must retain the selected subject scope.',
    );
  assert(
    body.effect_id === request.effect_id &&
      body.effect_sequence === request.effect_sequence &&
      body.run_id === request.run_id &&
      body.agent_run_request_digest === request.agent_run_request_digest &&
      body.effect_request_digest === digest &&
      body.decision.effect_request_digest === digest &&
      body.decision.subject_digest === body.observed_pre_effect_subject.digest &&
      same(body.observed_capability, request.capability) &&
      gaapObjectDigest(body) === effect.result.result_digest,
    'The effect result must retain its exact request, observed identities, decision and body digest.',
  );
  assert(
    new Set(body.evidence.map((entry) => canonicalGaapJson(entry))).size === body.evidence.length,
    'Effect evidence references must be unique.',
  );
  const subjectDrift = !same(body.observed_pre_effect_subject, request.subject),
    schemaDrift = body.observed_tool_schema_digest !== request.tool_schema_digest;
  const driftReasons = [
    'protected_effect.stale_subject',
    'protected_effect.capability_schema_drift',
    'protected_effect.subject_and_capability_schema_drift',
  ];
  if (subjectDrift || schemaDrift) {
    const reason = subjectDrift ? (schemaDrift ? driftReasons[2] : driftReasons[0]) : driftReasons[1];
    assert(
      body.execution_status === 'denied' && body.reason === reason,
      'Subject or capability-schema drift requires its exact denied outcome.',
    );
    if (subjectDrift) requireEvidence(effect, 'subject_observation');
    if (schemaDrift) requireEvidence(effect, 'capability_schema');
  } else
    assert(
      !driftReasons.includes(body.reason ?? ''),
      'A drift denial requires an actual observed identity difference.',
    );
}

function requireEvidence(effect: GaapEffect, ...types: string[]): void {
  assert(
    types.every((type) => effect.result.body.evidence.some((entry) => entry.evidence_type === type)),
    'The effect status requires its supporting evidence categories.',
  );
}
function verifyEffectOutcome(effect: GaapEffect): void {
  const request = effect.request,
    body = effect.result.body;
  const attempted = !['denied', 'awaiting_authority'].includes(body.execution_status);
  const expected =
    body.execution_status === 'denied' ? 'block' : body.execution_status === 'awaiting_authority' ? 'ask' : 'allow';
  assert(body.decision.decision.outcome === expected, 'The decision outcome must agree with execution status.');
  if (!attempted) {
    assert(
      body.reason !== null &&
        body.observed_post_effect_subject === null &&
        body.exit === null &&
        body.executor === null &&
        body.sandbox_profile === null &&
        Object.values(body.usage).every((value) => value === 0) &&
        body.evidence.every((entry) => ['subject_observation', 'capability_schema'].includes(entry.evidence_type)),
      'A non-executed result cannot claim execution-derived facts or usage.',
    );
    return;
  }
  assert(
    body.decision.gate === 'permission' &&
      body.executor !== null &&
      body.sandbox_profile !== null &&
      same(body.sandbox_profile, request.sandbox_profile) &&
      body.usage.tool_calls >= 1,
    'An attempt requires permission, executor/sandbox identities and tool usage.',
  );
  requireEvidence(effect, 'executor', 'sandbox', 'usage');
  assert(
    body.execution_status === 'executed' ? body.reason === null : body.reason !== null,
    'Executed and non-success attempts must retain truthful reason fields.',
  );
  const required =
    body.execution_status === 'failed'
      ? 'failure'
      : body.execution_status === 'interrupted'
        ? 'interruption'
        : body.execution_status === 'unknown_outcome'
          ? 'unknown_outcome'
          : null;
  if (required) requireEvidence(effect, required);
  assert(
    body.evidence.every(
      (entry) =>
        !['failure', 'interruption', 'unknown_outcome'].includes(entry.evidence_type) ||
        entry.evidence_type === required,
    ),
    'Effect evidence categories cannot contradict the execution outcome.',
  );
  if (body.execution_status === 'unknown_outcome')
    assert(body.exit === null, 'An unknown outcome cannot assert a known process exit.');
  else
    assert(body.observed_post_effect_subject !== null, 'A known attempt requires a post-effect subject observation.');
  if (body.observed_post_effect_subject) {
    requireEvidence(effect, 'subject_observation');
    if (request.expected_effect_class === 'observation')
      assert(
        body.observed_post_effect_subject.digest === request.subject.digest,
        'An observation must preserve the requested subject.',
      );
    else requireEvidence(effect, 'mutation', 'artifact');
  }
  if (request.operation_family === 'process') {
    if (['executed', 'failed'].includes(body.execution_status))
      assert(body.exit !== null, 'A known process outcome requires its exit status.');
    if (body.exit) requireEvidence(effect, 'exit');
  } else
    assert(
      body.exit === null && !body.evidence.some((entry) => entry.evidence_type === 'exit'),
      'Only process effects may retain process exits.',
    );
}
