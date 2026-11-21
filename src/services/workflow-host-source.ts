import { sha256 } from '../adapters/crypto/sha256.js';
import { ThreadloopError } from '../contracts/errors.js';
import { canonicalJson, isPlainObject } from '../domain/canonical-json.js';
import { parseGaapJson } from '../domain/gaap-json.js';
import { evaluateProofEvidence } from '../domain/proof.js';
import type { Batch, HostSource, RawSource, Receipt, WorkflowGenesis } from '../domain/workflow-run.js';

function invalid(message: string): never {
  throw new ThreadloopError('TRANSITION_GUARD_FAILED', message, {
    details: {
      reason: 'invalid_host_evidence',
      hint: 'Run the enrolled producer against the current subject and retain its original artifacts.',
    },
  });
}

function checkRaw(source: RawSource) {
  if (source.bytes.length > 10 * 1024 * 1024 || sha256(source.bytes) !== source.sha256)
    invalid('The retained artifact exceeds its limit or has changed.');
}
function same(left: unknown, right: unknown) {
  return canonicalJson(left) === canonicalJson(right);
}

function gateBatch(source: Extract<HostSource, { kind: 'local-gate' }>, genesis: WorkflowGenesis): Batch {
  const { receipt, producing, outputs } = source;
  const plan = genesis.proof_plan;
  const subject = producing.binding.subject;
  if (
    !plan ||
    subject.kind !== 'repository' ||
    !genesis.policy.rules.local_gate_ids.includes(receipt.gateId) ||
    receipt.stateVersion !== producing.binding.state_version ||
    receipt.artifactSha256 !== source.artifact.sha256
  )
    invalid('The local gate belongs to another plan, producer version or subject.');
  const evidence = evaluateProofEvidence({
    sessionId: genesis.run_id,
    plan,
    receipts: [receipt],
    currentHead: subject.revision,
    artifactDigests: new Map([[receipt.id, source.artifact.sha256]]),
    digest: sha256,
  }).gates.find((gate) => gate.gate_id === receipt.gateId);
  if (!evidence || ['missing', 'stale', 'corrupt'].includes(evidence.status))
    invalid('The stored local gate receipt failed verification.');
  const artifact = parseGaapJson(source.artifact.bytes);
  const payload: unknown = JSON.parse(receipt.receiptJson);
  if (!isPlainObject(artifact) || !isPlainObject(payload) || artifact.receipt_id !== receipt.id)
    invalid('The execution artifact has different receipt identities.');
  for (const field of [
    'session_id',
    'gate_id',
    'plan_sha256',
    'result',
    'command',
    'working_directory',
    'timeout_ms',
    'started_at',
    'ended_at',
    'duration_ms',
    'exit_status',
    'signal',
    'head_before',
    'head_after',
    'clean_before',
    'clean_after',
    'sensor',
  ]) {
    if (!same(artifact[field], payload[field]))
      invalid('The execution artifact and receipt disagree on ' + field + '.');
  }
  const expectedOutputs = new Map(outputs.map((entry) => [entry.path, entry.content]));
  if (expectedOutputs.size !== outputs.length) invalid('Local gate output paths must be unique.');
  const checkStream = (value: unknown, expectedHash?: unknown) => {
    if (!isPlainObject(value) || typeof value.path !== 'string') invalid('A local gate output is missing its path.');
    const output = expectedOutputs.get(value.path);
    if (
      !output ||
      value.sha256 !== output.sha256 ||
      value.bytes !== output.bytes.length ||
      (expectedHash !== undefined && expectedHash !== output.sha256)
    )
      invalid('The local gate output differs from the recorded stream.');
    checkRaw(output);
    expectedOutputs.delete(value.path);
  };
  if (artifact.stdout !== null || artifact.stderr !== null || artifact.setup === undefined) {
    checkStream(artifact.stdout);
    checkStream(artifact.stderr);
  }
  if (artifact.setup !== undefined || payload.setup !== undefined) {
    if (
      !Array.isArray(artifact.setup) ||
      !Array.isArray(payload.setup) ||
      artifact.setup.length !== payload.setup.length
    )
      invalid('The recorded setup steps differ.');
    for (const [index, step] of artifact.setup.entries()) {
      if (!isPlainObject(step) || !isPlainObject(step.output)) invalid('The setup output is invalid.');
      const { stdout, stderr, ...facts } = step;
      if (!same(facts, payload.setup[index])) invalid('The setup artifact differs from its receipt.');
      checkStream(stdout, step.output.stdout_sha256);
      checkStream(stderr, step.output.stderr_sha256);
    }
  }
  if (expectedOutputs.size > 0) invalid('The gate source contains unrelated outputs.');
  const measured = payload.ended_at;
  if (typeof measured !== 'string' || !Number.isFinite(Date.parse(measured)))
    invalid('The gate completion time is invalid.');
  const payloads: Receipt['payload'][] = [];
  if (receipt.result === 'passed') {
    if (
      evidence.status !== 'passed' ||
      payload.exit_status !== 0 ||
      payload.signal !== null ||
      artifact.stdout === null ||
      artifact.stderr === null
    )
      invalid('Passing local proof requires a clean, successful gate command.');
    payloads.push({ type: 'local_proof', gate_id: receipt.gateId, result: 'passed', clean: true });
  } else if (receipt.result === 'failed' || receipt.result === 'setup_failed') {
    payloads.push({
      type: 'local_proof',
      gate_id: receipt.gateId,
      result: receipt.result,
      clean: payload.clean_before === true && payload.clean_after === true,
    });
  }
  return {
    ...producing,
    stream: { kind: 'local-gate', gate_id: receipt.gateId },
    measured_at: new Date(measured).toISOString(),
    valid_until: null,
    applicable_version: null,
    authorized_edge: null,
    payloads,
  };
}

export function projectWorkflowHostSource(source: HostSource, genesis: WorkflowGenesis): Batch {
  const { producing } = source;
  const enrolled = genesis.source_policies[source.kind];
  if (
    !enrolled ||
    !same(enrolled, source.producer_id) ||
    !same(enrolled, producing.evidence_policy) ||
    !same(producing.workflow_policy, { id: genesis.policy.id, digest: genesis.policy.digest }) ||
    producing.binding.workflow_run_id !== genesis.run_id ||
    producing.binding.graph_digest !== genesis.compiled.graph_digest ||
    producing.branch !== genesis.baseline_branch
  )
    invalid('The run has no matching enrolled producer for this source.');
  checkRaw(source.artifact);
  if (source.kind === 'local-gate') return gateBatch(source, genesis);
  const artifact = parseGaapJson(source.artifact.bytes);
  const { review } = source;
  if (
    producing.binding.subject.kind !== 'repository' ||
    review.headSha !== producing.binding.subject.revision ||
    source.reviewer_id.trim() === '' ||
    !Number.isFinite(Date.parse(source.observed_at)) ||
    review.evidenceSha256 !== source.artifact.sha256 ||
    !isPlainObject(artifact) ||
    artifact.reviewer_id !== source.reviewer_id ||
    artifact.head_sha !== review.headSha ||
    artifact.observed_at !== source.observed_at ||
    artifact.outcome !== review.outcome ||
    !Array.isArray(artifact.findings)
  )
    invalid('The current-head review and its retained artifact differ.');
  const findings = artifact.findings.map((item) => {
    if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id || typeof item.blocking !== 'boolean')
      invalid('A review finding lacks its identity or blocking status.');
    return { id: item.id, blocking: item.blocking };
  });
  if (
    new Set(findings.map((f) => f.id)).size !== findings.length ||
    !same(findings, source.findings) ||
    !same(
      review.findings.map((f) => f.id),
      findings.map((f) => f.id),
    ) ||
    (review.outcome === 'clean' && findings.some((f) => f.blocking))
  )
    invalid('The review omits or contradicts its findings.');
  return {
    ...producing,
    stream: { kind: 'pre-pr-review' },
    measured_at: new Date(source.observed_at).toISOString(),
    valid_until: null,
    applicable_version: null,
    authorized_edge: null,
    payloads: [{ type: 'pre_pr_review', outcome: review.outcome, findings }],
  };
}
