import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildActionRequest, type ControllerInput } from 'threadloop-contracts/controller';
import { requestReference } from 'threadloop-contracts/execution';
import type { GaapMappingPolicy, GaapRequest } from 'threadloop-contracts/executor';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { observeGaapWorkspace } from '../../src/adapters/fs/gaap-files.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { gaapVerificationPolicy, type GaapBinding, type GaapHost } from '../../src/domain/gaap-binding.js';
import { gaapFixture } from './gaap.js';

export async function controllerFixture(mode = 'success') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'threadloop-controller-')));
  const workspace = path.join(root, 'repository');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'owned test source\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
  git('init', '-b', 'feature');
  git('add', 'source.txt');
  git(
    '-c',
    'user.name=ThreadLoop Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'initial test subject',
  );
  const fixture = await gaapFixture();
  const host: GaapHost = {
    schema_version: 'threadloop.gaap-host/1',
    executable: process.execPath,
    arguments: [
      fileURLToPath(import.meta.resolve('tsx/cli')),
      fileURLToPath(new URL('./gaap-producer.ts', import.meta.url)),
    ],
    workspace,
    environment: { TEST_GAAP_MODE: mode },
    timeout_ms: 5000,
    verification: {
      id: 'explicit-test-verification',
      keys: fixture.keys.map((key) => ({
        key_id: key.keyId,
        public_key_hex: Buffer.from(key.publicKey).toString('hex'),
      })),
      implementation: {
        name: 'threadloop-test-only',
        version: '1',
        digest: 'sha256:' + sha256('synthetic fixture producer'),
      },
    },
  };
  fixture.expected.approval_context = [];
  return {
    root,
    workspace,
    state: path.join(root, 'state'),
    host,
    binding: await controllerBinding(workspace, host, fixture.expected),
  };
}

/** Fresh binding built before a native or explicitly synthetic executor starts. */
export async function controllerBinding(
  workspace: string,
  host: GaapHost,
  template: GaapRequest,
): Promise<GaapBinding> {
  const asset = (name: string) => new URL(import.meta.resolve('threadloop-contracts/assets/' + name));
  const controller = JSON.parse(
    await readFile(asset('controller-v0.1/fixtures/valid/independent_proof_required.json'), 'utf8'),
  ) as { input: ControllerInput };
  const snapshot = controller.input;
  snapshot.compiled_graph = JSON.parse(
    await readFile(asset('workflow-graph-v0.1/fixtures/valid/governed-pr.compiled.json'), 'utf8'),
  ) as ControllerInput['compiled_graph'];
  const observed = observeGaapWorkspace(workspace);
  const subject: ControllerInput['binding']['subject'] = {
    kind: 'repository',
    repository_id: 'owned-test-repository',
    revision: observed.revision,
    content_digest: observed.digest,
  };
  snapshot.binding.subject = subject;
  snapshot.binding.source_state = 'implementing';
  snapshot.binding.state_version = 2;
  snapshot.observation = {
    ...snapshot.observation,
    subject,
    state_version: 2,
    repository: {
      branch: observed.branch,
      clean: observed.clean,
      basis: subject,
      relationship: 'equal',
      change_scope: 'within_plan',
    },
  };
  if (snapshot.history.status === 'verified') {
    snapshot.history.phase = 'pre_pr';
    snapshot.history.implementation_basis = subject;
  }
  snapshot.policy.rules.repository_binding = { branch: observed.branch, baseline: subject };
  snapshot.policy.rules.evidence_policies = [gaapVerificationPolicy(host)];
  snapshot.policy.digest = sha256(canonicalJson(snapshot.policy.rules));
  snapshot.receipts = [];
  snapshot.execution = { status: 'idle' };
  snapshot.existing_requests = [];
  snapshot.invalidated_claims = [];
  snapshot.evaluation_time = new Date().toISOString();
  const action = buildActionRequest(snapshot, {
    action_id: 'implement',
    transition_id: 'verify_implementation',
    guard_ids: ['work_committed'],
    inputs: [],
    evidence_ids: [],
    evidence_requirements: [{ family: 'repository_observation', guard_id: 'work_committed', subject }],
    valid_until: null,
  });
  if (!action.ok) throw new Error(JSON.stringify(action.diagnostics));
  const rules = {
    request: requestReference(action.value),
    workflow_policy: { id: snapshot.policy.id, digest: snapshot.policy.digest },
    retry_safety: 'reconciliation_required' as const,
    max_attempts: 1,
  };
  const capability = {
    ...template.requested_capability,
    digest: template.requested_capability.digest.slice(7),
  };
  const policies = template.policies.map((entry) => ({ ...entry, digest: entry.digest.slice(7) }));
  const mapping: GaapMappingPolicy['policy'] = {
    schema_version: 'threadloop.gaap-mapping/0.1',
    id: 'owned-test-mapping',
    action_capability: 'implement_change',
    capability,
    policies,
    evidence_mapping: [{ family: 'repository_observation', evidence_types: ['command_output', 'artifact'] }],
  };
  const binding: GaapBinding = {
    schema_version: 'threadloop.gaap-binding/1',
    snapshot,
    action_request: action.value,
    execution_policy: { id: 'owned-test-execution', digest: sha256(canonicalJson(rules)), rules },
    mapping_policy: { policy: mapping, policy_digest: sha256(canonicalJson(mapping)) },
    parameters: {
      subject_locator: workspace,
      capability,
      policies,
      task: template.task,
      resource_budget: template.resource_budget,
      approval_context: template.approval_context.map((approval) => ({
        ...approval,
        subject_digest: approval.subject_digest.slice(7),
        evidence: {
          ...approval.evidence,
          locator: approval.evidence.locator ?? null,
          digest: approval.evidence.digest.slice(7),
        },
      })),
      required_verification: template.required_verification,
    },
    executor: { id: 'test-executor', incarnation: 'one' },
    lease_ms: 30000,
  };
  return binding;
}
