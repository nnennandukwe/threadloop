import { initialExecution, operate, grant, target, executorA } from './execution-contract.js';
import { executionDigest } from '../../scripts/execution-contract/model.js';
import type { ExecutorRequest, GaapMappingPolicy } from '../../scripts/executor-contract/contracts.js';
import { executionAdmissionDigest } from '../../scripts/execution-contract/authority.js';
import { executorRequestAdmissionDigest } from '../../scripts/executor-contract/validation.js';
import type { ExecutionJournal } from '../../scripts/execution-contract/contracts.js';

export async function executorFixture() {
  const initial = await initialExecution();
  const acquired = operate(initial.journal, grant);
  const started = operate(acquired.journal, { kind: 'start', ...target });
  const capability = { name: 'run-local-gates', version: '1', digest: 'c'.repeat(64) };
  const policies = [{ name: 'gaap.run-coordinator', version: '0.1.0', digest: 'b'.repeat(64) }];
  const policy: GaapMappingPolicy['policy'] = {
    schema_version: 'threadloop.gaap-mapping/0.1',
    id: 'local_gates_gaap',
    action_capability: 'run_local_gates',
    capability,
    policies,
    evidence_mapping: [{ family: 'local_proof', evidence_types: ['command_output'] }],
  };
  const mapping = { policy, policy_digest: executionDigest(policy) };
  const request: ExecutorRequest['request'] = {
    schema_version: 'threadloop.executor/0.1',
    kind: 'execute',
    action_request: initial.request,
    execution_policy: { id: initial.policy.id, digest: initial.policy.digest },
    ...target,
    executor: executorA,
    mapping_policy: { id: policy.id, digest: mapping.policy_digest },
    parameters: {
      subject_locator: 'https://example.invalid/threadloop-contract-fixture',
      capability: structuredClone(capability),
      task: {
        instructions: 'Run the exact declared local gate and retain its output.',
        constraints: ['Do not modify or publish the subject.'],
      },
      policies: structuredClone(policies),
      resource_budget: {
        max_cost_micros: 1000000,
        max_elapsed_ms: 60000,
        max_model_tokens: 100000,
        max_tool_calls: 100,
      },
      approval_context: [],
      required_verification: { independence: 'different_actor', evidence_types: ['command_output'] },
    },
  };
  return {
    ...initial,
    started,
    mapping,
    envelope: { request: structuredClone(request), request_digest: executionDigest(request) },
  };
}

/** Test-only trusted allowlist, deliberately external to every JSON message under test. */
export function executorFixtureAuthority(journal: ExecutionJournal, snapshot: unknown, request?: ExecutorRequest) {
  const admitted = new Set<string>();
  admitted.add(
    executionAdmissionDigest({
      kind: 'create',
      context: journal.execution.initial_context,
      request: journal.execution.action_request,
      policy: journal.execution.execution_policy,
    }),
  );
  for (const entry of journal.execution.entries)
    admitted.add(
      executionAdmissionDigest({
        kind: 'operation',
        execution_digest: entry.operation.expected_execution_digest,
        context: entry.context,
        operation: entry.operation,
      }),
    );
  admitted.add(executionAdmissionDigest({ kind: 'projection', execution_digest: journal.execution_digest, snapshot }));
  if (request) admitted.add(executorRequestAdmissionDigest(request));
  return { isAdmitted: (digest: string) => admitted.has(digest) };
}
