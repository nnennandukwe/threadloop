import { verifySigstoreReceipt } from '../adapters/crypto/sigstore.js';
import { sha256 } from '../adapters/crypto/sha256.js';
import { nodeSignedReceiptFileSystem } from '../adapters/fs/signed-receipt-files.js';
import { ThreadloopError } from '../contracts/errors.js';
import {
  isPreparedReceiptId,
  parseSignedReceiptEnvelope,
  parseSignedReceiptPackage,
  type SignedGateReceiptArtifact,
} from '../domain/attestation.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { hasReviewTrustPolicy } from '../domain/proof.js';
import { escapeRegExp, workflowDeadline } from '../domain/validation.js';
import { parseGaapJson } from '../domain/gaap-json.js';
import {
  hasBlockingReview,
  parseSignedReviewReceiptEnvelope,
  parseSignedReviewReceiptPackage,
  reviewEvidenceFromArtifact,
  type SignedReviewReceiptArtifact,
} from '../domain/review.js';
import type {
  Batch,
  Preparation,
  RawSource,
  Receipt,
  SignedKind,
  SignedSource,
  WorkflowGenesis,
} from '../domain/workflow-run.js';
import { MAX_SIGNED_RECEIPT_PACKAGE_BYTES } from './signed-receipt-files.js';
import {
  readWorkflowInstructionObjects,
  verifyRetainedInstructionObjects,
  workflowInstructionPayloads,
} from './workflow-instruction.js';
import {
  assertSignedGateContext,
  assertSignedReviewContext,
  assertSignerProjection,
  mapSignedReceiptParseError,
  verifySigner,
} from './signed-receipt-import.js';

function decode(bytes: Uint8Array) {
  return parseGaapJson(bytes, { maxBytes: MAX_SIGNED_RECEIPT_PACKAGE_BYTES });
}

export async function readSignedSource(file: string, kind: SignedKind) {
  let result;
  try {
    result = await nodeSignedReceiptFileSystem.readWithinLimit(file, MAX_SIGNED_RECEIPT_PACKAGE_BYTES);
  } catch (cause) {
    throw new ThreadloopError('SIGNED_RECEIPT_INVALID', 'Provide a readable signed receipt package.', { cause });
  }
  if (result.status !== 'ok') throw new ThreadloopError('SIGNED_RECEIPT_INVALID', 'The signed package exceeds 10 MiB.');
  const { bytes } = result;
  let preparedId: string;
  try {
    const value = decode(bytes);
    const envelope =
      kind === 'signed-gate'
        ? parseSignedReceiptEnvelope(value, sha256)
        : parseSignedReviewReceiptEnvelope(value, sha256);
    preparedId = envelope.artifact.receipt_id;
  } catch (error) {
    throw mapSignedReceiptParseError(error);
  }
  if (!isPreparedReceiptId(preparedId))
    throw new ThreadloopError('SIGNED_RECEIPT_INVALID', 'Collect a receipt using the prepared Workflow Run ID.');
  return { raw: { bytes, sha256: sha256(bytes) }, preparedId };
}

function reject(message: string): never {
  throw new ThreadloopError('SIGNED_RECEIPT_INVALID', message, {
    details: { reason: 'prepared_source_mismatch', hint: 'Prepare and collect a fresh receipt for the bound target.' },
  });
}

function sourcePolicy(genesis: WorkflowGenesis, prepared: Preparation) {
  const plan = genesis.proof_plan;
  const github = genesis.sources?.github;
  if (!plan || !github || !hasReviewTrustPolicy(plan.plan) || plan.plan.contract_version !== 4)
    reject('The Workflow Run requires a bound v4 proof plan and a GitHub source policy.');
  const policy = prepared.target.kind === 'signed-gate' ? plan.plan.ci : plan.plan.review;
  return { plan, github, policy };
}

type VerifiedReview = Extract<SignedSource, { kind: 'signed-review' | 'signed-instruction' }>;

function requireSourceBinding(source: SignedSource, genesis: WorkflowGenesis, prepared: Preparation) {
  const { policy } = sourcePolicy(genesis, prepared);
  const artifact = source.parsed.artifact;
  const subject = prepared.binding.subject;
  if (
    source.kind !== prepared.target.kind ||
    !isPreparedReceiptId(prepared.prepared_id) ||
    prepared.prepared_id !== artifact.receipt_id ||
    subject.kind !== 'repository' ||
    subject.repository_id !== genesis.setup.repository_id ||
    genesis.run_id !== prepared.binding.workflow_run_id ||
    genesis.compiled.graph_digest !== prepared.binding.graph_digest ||
    genesis.policy.id !== prepared.workflow_policy.id ||
    genesis.policy.digest !== prepared.workflow_policy.digest ||
    canonicalJson(genesis.source_policies[source.kind] ?? null) !== canonicalJson(prepared.evidence_policy)
  ) {
    reject("The signed source doesn't match its prepared run, graph, target and policies.");
  }
  assertSignerProjection(source.signer, artifact.source, policy, source.kind === 'signed-gate' ? 'CI' : 'review');
  const invocation = new RegExp(
    `^${escapeRegExp(artifact.source.repository)}/actions/runs/[1-9][0-9]*/attempts/[1-9][0-9]*$`,
  );
  if (
    !invocation.test(artifact.source.run_invocation_uri) ||
    !policy.certificate_identity.endsWith('@' + artifact.source.ref)
  ) {
    reject('The signed invocation must match the enrolled caller workflow ref and identify a GitHub run attempt.');
  }
  return subject;
}

function namedApproval(artifact: SignedReviewReceiptArtifact, actor: string) {
  const matches = artifact.review.approvals.filter((approval) => approval.actor_id === actor);
  if (matches.length > 1) reject('A prepared review must contain at most one latest opinion per enrolled actor.');
  const approval = matches[0];
  return approval &&
    approval.actor_type === 'User' &&
    approval.state === 'APPROVED' &&
    approval.commit_sha === artifact.pull_request.head_sha &&
    Date.parse(approval.submitted_at) <= Date.parse(artifact.observed_at)
    ? approval
    : null;
}

function checkReview(source: VerifiedReview, genesis: WorkflowGenesis, prepared: Preparation) {
  const subject = requireSourceBinding(source, genesis, prepared);
  const { policy, plan, github } = sourcePolicy(genesis, prepared);
  const artifact = source.parsed.artifact;
  const pull = artifact.pull_request;
  const target = prepared.pull_request;
  if (
    prepared.target.kind === 'signed-gate' ||
    !target ||
    target.number !== prepared.target.pr ||
    pull.number !== target.number ||
    pull.url !== target.url ||
    pull.base_ref !== target.base_ref ||
    target.base_ref !== github.base_ref ||
    (source.kind === 'signed-instruction' && artifact.source.ref !== 'refs/heads/' + target.base_ref)
  ) {
    reject('The signed review must describe the prepared pull request, URL and base.');
  }
  assertSignedReviewContext({
    requestedSessionId: genesis.run_id,
    plan,
    expectedRepository: subject.repository_id,
    currentHead: source.kind === 'signed-instruction' ? pull.head_sha : subject.revision,
    receipt: source.parsed,
    policy,
  });
  if (
    Date.parse(artifact.observed_at) < Date.parse(prepared.prepared_at) ||
    (pull.merged_at && Date.parse(pull.merged_at) > Date.parse(artifact.observed_at))
  ) {
    reject('The signed review must follow preparation and any merge it reports.');
  }
  const approval = namedApproval(artifact, github.human_node_id);
  return source.kind === 'signed-instruction' &&
    approval &&
    Date.parse(approval.submitted_at) < Date.parse(prepared.prepared_at)
    ? null
    : approval;
}

export async function verifyWorkflowSignedSource(
  raw: RawSource,
  genesis: WorkflowGenesis,
  prepared: Preparation,
  verifier: typeof verifySigstoreReceipt = verifySigstoreReceipt,
): Promise<SignedSource> {
  if (raw.sha256 !== sha256(raw.bytes)) reject('The raw signed package digest changed before verification.');
  const { policy } = sourcePolicy(genesis, prepared);
  const kind = prepared.target.kind;
  let source: SignedSource;
  try {
    const value = decode(raw.bytes);
    if (kind === 'signed-gate') {
      const parsed = parseSignedReceiptPackage(value, sha256);
      source = { kind, raw, parsed, signer: await verifySigner(parsed, policy, verifier) };
    } else {
      const parsed = parseSignedReviewReceiptPackage(value, sha256);
      const signer = await verifySigner(parsed, policy, verifier);
      source = kind === 'signed-review' ? { kind, raw, parsed, signer } : { kind, raw, parsed, signer, objects: [] };
      if (source.kind === 'signed-instruction' && checkReview(source, genesis, prepared)) {
        source.objects = readWorkflowInstructionObjects(genesis, prepared, parsed, signer);
      }
    }
  } catch (error) {
    if (error instanceof ThreadloopError) throw error;
    throw mapSignedReceiptParseError(error);
  }
  projectWorkflowSignedSource(source, genesis, prepared);
  return source;
}

function checkGateOutcome(gate: SignedGateReceiptArtifact, preparedAt: string, head: string) {
  if (gate.started_at < preparedAt || gate.ended_at < gate.started_at) {
    reject('The signed gate must start after preparation and finish after it starts.');
  }
  if (gate.result === 'failed' && (gate.exit_status === null || gate.exit_status === 0) && gate.signal === null) {
    reject('The signed failure requires a failing process outcome.');
  }
  if (gate.result !== 'passed') return;
  if (!gate.clean_before || !gate.clean_after || gate.exit_status !== 0 || gate.signal !== null) {
    reject('A passing signed gate requires clean observations, zero exit status and no signal.');
  }
  let previousEnd = gate.started_at;
  for (const step of gate.setup ?? []) {
    if (
      !step.clean_before ||
      !step.clean_after ||
      step.exit_status !== 0 ||
      step.signal !== null ||
      step.head_before !== head ||
      step.head_after !== head ||
      step.started_at < previousEnd ||
      step.ended_at < step.started_at ||
      step.ended_at > gate.ended_at
    ) {
      reject('Each passing setup step must complete at the prepared clean HEAD within the gate execution window.');
    }
    previousEnd = step.ended_at;
  }
}

export function projectWorkflowSignedSource(
  source: SignedSource,
  genesis: WorkflowGenesis,
  prepared: Preparation,
): Batch {
  const { policy, plan, github } = sourcePolicy(genesis, prepared);
  const payloads: Receipt['payload'][] = [];
  let measuredAt: string;
  let stream: Batch['stream'];
  let applicableVersion: number | null = null;
  let authorizedEdge: string | null = null;
  if (source.kind === 'signed-gate') {
    const subject = requireSourceBinding(source, genesis, prepared);
    const gate = source.parsed.artifact;
    if (
      prepared.target.kind !== 'signed-gate' ||
      gate.gate.id !== prepared.target.gate_id ||
      !genesis.policy.rules.independent_gate_ids.includes(gate.gate.id)
    )
      reject('The signed gate must match the declared independent gate.');
    assertSignedGateContext({
      requestedSessionId: genesis.run_id,
      plan,
      expectedRepository: subject.repository_id,
      currentBranch: prepared.branch,
      currentHead: subject.revision,
      receipt: source.parsed,
      policy,
      gate: plan.plan.gates.find((item) => item.id === gate.gate.id),
    });
    checkGateOutcome(gate, prepared.prepared_at, subject.revision);
    if (gate.result === 'passed' || gate.result === 'failed')
      payloads.push({ type: 'independent_proof', gate_id: gate.gate.id, result: gate.result });
    measuredAt = gate.ended_at;
    stream = { kind: 'signed-gate', gate_id: gate.gate.id };
  } else {
    const approval = checkReview(source, genesis, prepared);
    const artifact = source.parsed.artifact;
    const pull = artifact.pull_request;
    measuredAt = new Date(artifact.observed_at).toISOString();
    if (source.kind === 'signed-review') {
      const review = reviewEvidenceFromArtifact(artifact, pull.head_sha);
      payloads.push({
        type: 'review',
        outcome: hasBlockingReview(review) ? 'changes_required' : 'clean',
        findings: artifact.review.threads.map((thread) => ({
          id: thread.id,
          blocking: !thread.resolved && !thread.outdated,
          outdated: thread.outdated,
        })),
      });
      if (approval)
        payloads.push({
          type: 'human_approval',
          scope: 'current_subject',
          approver: { type: 'human', id: approval.actor_id },
          reason: `Approved pull request ${pull.number} at ${pull.head_sha}.`,
        });
      if (pull.merged && pull.merged_at)
        payloads.push({ type: 'completion_observed', kind: 'merge', destination: pull.url });
      stream = { kind: 'signed-review', pr: pull.number };
    } else {
      if (prepared.target.kind !== 'signed-instruction')
        reject('The signed instruction requires an instruction preparation.');
      const instruction = prepared.target.instruction;
      if (approval) {
        verifyRetainedInstructionObjects(prepared, source.parsed, source.signer, source.objects);
        payloads.push(...workflowInstructionPayloads(prepared));
      } else if (source.objects.length > 0) reject('A withdrawn instruction has no approved Git object proof.');
      applicableVersion = prepared.binding.state_version;
      authorizedEdge = instruction.purpose === 'request_stop' ? null : instruction.transition_id;
      stream = {
        kind: 'signed-instruction',
        pr: pull.number,
        version: applicableVersion,
        purpose: instruction.purpose,
      };
    }
  }
  const deadline = workflowDeadline(measuredAt, github.evidence_ttl_ms);
  if (!deadline) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_INVALID',
      'The signed evidence deadline exceeds the Workflow Run timestamp range.',
      {
        details: { reason: 'invalid_workflow_deadline', hint: 'Use a new run with a shorter evidence lifetime.' },
      },
    );
  }
  return {
    binding: prepared.binding,
    branch: prepared.branch,
    workflow_policy: prepared.workflow_policy,
    evidence_policy: prepared.evidence_policy,
    stream,
    measured_at: measuredAt,
    valid_until: deadline,
    applicable_version: applicableVersion,
    authorized_edge: authorizedEdge,
    payloads,
  };
}
