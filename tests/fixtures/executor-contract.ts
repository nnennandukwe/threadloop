import { readFile } from 'node:fs/promises';
import { initialExecution, operate, grant, target, executorA } from './execution-contract.js';
import { digest } from '../../scripts/contract-kernel/kernel.js';
import type { ExecutorRequest, GaapMappingPolicy } from '../../scripts/executor-contract/contracts.js';
import { canonicalExecutorJson } from '../../scripts/executor-contract/codec.js';
import type { GaapReceipt, GaapRequest } from '../../scripts/executor-contract/gaap-types.js';
import { executionAdmissionDigest } from '../../scripts/execution-contract/authority.js';
import { executorRequestAdmissionDigest } from '../../scripts/executor-contract/validation.js';
import type { ExecutionJournal } from '../../scripts/execution-contract/contracts.js';

const published = new URL('../../docs/contracts/executor-v0.1/', import.meta.url);

/** A committed executor-v0.1 document, parsed fresh for each caller to mutate. */
export async function executorJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(new URL(path, published), 'utf8')) as T;
}

/** The published local-gates request and mapping with one published GAAP receipt and its observation. */
export async function gaapMappingFixture(name = 'completed') {
  const fixture = await executorJson<{ request: ExecutorRequest; mapping: GaapMappingPolicy }>(
    'fixtures/local-gates.json',
  );
  const receipt = await executorJson<GaapReceipt>(`fixtures/${name}.gaap.canonical`);
  const scenario = await executorJson<{ observation: unknown }>(`fixtures/${name}.json`);
  return { ...fixture, receipt, ...scenario };
}

/** The pinned upstream request and completed receipt, independent of ThreadLoop mapping. */
export async function nativeGaapFixture() {
  return {
    request: await executorJson<GaapRequest>('upstream/gaap/agent-run-request.json'),
    receipt: await executorJson<GaapReceipt>('upstream/gaap/completed.json'),
  };
}

/** Renumber events and recompute the receipt digest after a test edits the ledger. */
export function resealGaap(receipt: GaapReceipt) {
  receipt.body.events.forEach((event, index) => {
    event.sequence = index + 1;
  });
  receipt.receipt_digest = 'sha256:' + digest(receipt.body);
  return receipt;
}

export function gaapBytes(receipt: GaapReceipt) {
  const encoded = canonicalExecutorJson(resealGaap(receipt));
  if (!encoded.ok) throw new Error(JSON.stringify(encoded));
  return Buffer.from(encoded.value);
}

export async function executorFixture() {
  const initial = await initialExecution();
  if (initial.request.request.actor !== 'executor') throw new Error('Executor fixture requires an executor action.');
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
  const mapping = { policy, policy_digest: digest(policy) };
  const request: ExecutorRequest['request'] = {
    schema_version: 'threadloop.executor/0.1',
    kind: 'execute',
    action_request: { ...initial.request, request: initial.request.request },
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
    envelope: { request: structuredClone(request), request_digest: digest(request) },
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
