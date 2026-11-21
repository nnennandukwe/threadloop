import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { prepareWorkflowGenesis } from '../../src/services/workflow-genesis.js';
import type { Preparation, PrepareTarget, WorkflowGenesis } from '../../src/domain/workflow-run.js';
import {
  readSignedSource,
  projectWorkflowSignedSource,
  verifyWorkflowSignedSource,
} from '../../src/services/workflow-signed-source.js';
import {
  boundGateArtifact,
  boundReviewArtifact,
  fixtureRepository,
  gateArtifact,
  signedGatePackage,
  signedReviewPackage,
  trustPolicy,
  verifiedSigner,
} from '../fixtures/receipts.js';
import { cleanupTemporaryState, makeTempDir, makeCommittedRepo, proofPlan } from '../helpers/session.js';

const preparedId = 'wfr_0123456789abcdef0123456789abcdef';
afterEach(cleanupTemporaryState);

it('retains the exact signed package bytes and takes the prepared ID from its artifact', async () => {
  const file = path.join(await makeTempDir(), 'receipt.json');
  const json = JSON.stringify(signedGatePackage({ ...gateArtifact(), receipt_id: preparedId }), null, 1) + '\n';
  await writeFile(file, json);
  const source = await readSignedSource(file, 'signed-gate');
  expect(source.preparedId).toBe(preparedId);
  expect(Buffer.from(source.raw.bytes).toString()).toBe(json);
  expect(source.raw.sha256).toBe(sha256(json));
  await expect(readSignedSource(file, 'signed-review')).rejects.toThrow();
  await writeFile(file, JSON.stringify(signedGatePackage()));
  await expect(readSignedSource(file, 'signed-gate')).rejects.toThrow(/prepared/i);
});

const fixtureTime = '2026-07-23T17:59:00.000Z';

async function governedGenesis(plan = proofPlan(), evidenceTtlMs = 900000) {
  const root = await makeTempDir();
  const subject = await makeCommittedRepo();
  await writeFile(
    path.join(root, 'plan.json'),
    JSON.stringify({ ...plan, review: trustPolicy('review', 'threadloop.yml', 'main') }),
  );
  await writeFile(
    path.join(root, 'sources.json'),
    JSON.stringify({
      schema_version: 'threadloop.workflow-sources/1',
      host_producers: [],
      github: { base_ref: 'main', human_node_id: 'user-1', preparation_ttl_ms: 300000, evidence_ttl_ms: evidenceTtlMs },
    }),
  );
  await writeFile(
    path.join(root, 'setup.json'),
    JSON.stringify({
      schema_version: 'threadloop.workflow-setup/1',
      subject_workspace: subject,
      repository_id: fixtureRepository,
      policy: {
        id: 'governed-pr',
        proof_binding_transition_id: 'bind_plan',
        independent_gate_ids: ['check'],
        local_gate_ids: ['check'],
        publication_destination: null,
      },
      proof_plan: 'plan.json',
      trusted_sources: 'sources.json',
      allowed_change_paths: ['README.md'],
    }),
  );
  const profile = createRequire(import.meta.url).resolve(
    'threadloop-contracts/assets/workflow-graph-v0.1/fixtures/valid/governed-pr.yaml',
  );
  return prepareWorkflowGenesis(root, 'session_wf_receipt', profile, 'setup.json').build(fixtureTime);
}

function preparation(genesis: WorkflowGenesis, target: PrepareTarget): Preparation {
  const plan = genesis.proof_plan!;
  return {
    prepared_id: preparedId,
    prepared_at: fixtureTime,
    valid_until: '2026-07-23T18:04:00.000Z',
    binding: {
      workflow_run_id: genesis.run_id,
      graph_schema_version: '0.1',
      graph_digest: genesis.compiled.graph_digest,
      source_state: 'framed',
      state_version: 3,
      subject: genesis.baseline,
    },
    branch: genesis.baseline_branch,
    workflow_policy: { id: genesis.policy.id, digest: genesis.policy.digest },
    evidence_policy: genesis.source_policies[target.kind]!,
    target,
    manifest_json: null,
    pull_request:
      target.kind === 'signed-gate'
        ? null
        : { number: target.pr, url: fixtureRepository + '/pull/' + target.pr, base_ref: 'main' },
    sensor_inputs: {
      session_id: genesis.run_id,
      plan_sha256: plan.sha256,
      prepared_receipt_id: preparedId,
      ...(target.kind === 'signed-gate'
        ? { gate_id: target.gate_id, gate_json: JSON.stringify(plan.plan.gates[0]) }
        : { pull_request_number: target.pr }),
    },
  };
}

function rawPackage(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return { bytes, sha256: sha256(bytes) };
}

it('rechecks the evidence deadline at its signed measurement time', async () => {
  const lifetime = Date.parse('9999-12-31T23:59:59.999Z') - Date.parse(fixtureTime);
  const genesis = await governedGenesis(proofPlan(), lifetime);
  const prepared = preparation(genesis, { kind: 'signed-gate', gate_id: 'check' });
  const plan = genesis.proof_plan!;
  const artifact = boundGateArtifact(
    {
      sessionId: genesis.run_id,
      planSha256: plan.sha256,
      head: genesis.baseline.revision,
      gate: plan.plan.gates[0]!,
    },
    { receipt_id: preparedId },
  );
  await expect(
    verifyWorkflowSignedSource(
      rawPackage(signedGatePackage(artifact)),
      genesis,
      prepared,
      verifiedSigner('gate', artifact),
    ),
  ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_INVALID', details: { reason: 'invalid_workflow_deadline' } });
});

it('authenticates the configured gate, preserves its producer version and maps only the signed result', async () => {
  const genesis = await governedGenesis();
  const prepared = preparation(genesis, { kind: 'signed-gate', gate_id: 'check' });
  const plan = genesis.proof_plan!;
  const binding = {
    sessionId: genesis.run_id,
    planSha256: plan.sha256,
    head: genesis.baseline.revision,
    gate: plan.plan.gates[0]!,
  };
  const passed = boundGateArtifact(binding, { receipt_id: preparedId });
  const verify = (artifact: typeof passed) =>
    verifyWorkflowSignedSource(
      rawPackage(signedGatePackage(artifact)),
      genesis,
      prepared,
      verifiedSigner('gate', artifact),
    );
  await expect(
    verifyWorkflowSignedSource(rawPackage(signedGatePackage(passed, { transparency: false })), genesis, prepared),
  ).rejects.toMatchObject({ code: 'SIGNED_RECEIPT_TRANSPARENCY_MISSING' });
  const projected = projectWorkflowSignedSource(await verify(passed), genesis, prepared);
  expect(projected).toMatchObject({
    binding: { state_version: 3 },
    stream: { kind: 'signed-gate', gate_id: 'check' },
    payloads: [{ type: 'independent_proof', gate_id: 'check', result: 'passed' }],
    measured_at: passed.ended_at,
  });
  const failed = { ...passed, result: 'failed' as const, exit_status: 1 };
  expect(projectWorkflowSignedSource(await verify(failed), genesis, prepared).payloads).toEqual([
    { type: 'independent_proof', gate_id: 'check', result: 'failed' },
  ]);
  expect(
    projectWorkflowSignedSource(await verify({ ...failed, result: 'aborted' }), genesis, prepared).payloads,
  ).toEqual([]);
  await expect(verify({ ...passed, receipt_id: 'wfr_' + 'f'.repeat(32) })).rejects.toThrow();
  await expect(verify({ ...passed, session_id: 'session_wf_other' })).rejects.toThrow();
  await expect(verify({ ...passed, clean_after: false })).rejects.toThrow();
  await expect(verify({ ...failed, exit_status: null, signal: null })).rejects.toThrow();
  await expect(
    verifyWorkflowSignedSource(
      rawPackage(signedGatePackage(passed)),
      genesis,
      prepared,
      verifiedSigner('review', passed),
    ),
  ).rejects.toThrow();
});

it('requires each step of a passing gate to prove clean execution at the prepared HEAD', async () => {
  const step = { id: 'provision', command: ['npm', 'ci'], working_directory: '.', timeout_ms: 5000 };
  const genesis = await governedGenesis(proofPlan({ setup: [step] }));
  const prepared = preparation(genesis, { kind: 'signed-gate', gate_id: 'check' });
  const plan = genesis.proof_plan!;
  const binding = {
    sessionId: genesis.run_id,
    planSha256: plan.sha256,
    head: genesis.baseline.revision,
    gate: plan.plan.gates[0]!,
  };
  const gate = boundGateArtifact(binding, { receipt_id: preparedId });
  const recorded = {
    ...step,
    started_at: gate.started_at,
    ended_at: gate.ended_at,
    duration_ms: gate.duration_ms,
    result: 'passed' as const,
    exit_status: 0,
    signal: null,
    clean_before: true,
    clean_after: true,
    head_before: binding.head,
    head_after: binding.head,
    output: gate.output,
  };
  const verify = (fields: Partial<typeof recorded>) => {
    const artifact = { ...gate, setup: [{ ...recorded, ...fields }] };
    return verifyWorkflowSignedSource(
      rawPackage(signedGatePackage(artifact)),
      genesis,
      prepared,
      verifiedSigner('gate', artifact),
    );
  };
  expect((await verify({})).kind).toBe('signed-gate');
  for (const invalid of [
    { exit_status: 1 },
    { clean_after: false },
    { head_before: '9'.repeat(40) },
    { ended_at: '2026-07-23T21:00:00.000Z' },
  ])
    await expect(verify(invalid)).rejects.toThrow();
});

it('projects the enrolled reviewer and observed merge at the product head independently of the caller revision', async () => {
  const genesis = await governedGenesis();
  const prepared = preparation(genesis, { kind: 'signed-review', pr: 42 });
  const original = boundReviewArtifact(
    { sessionId: genesis.run_id, planSha256: genesis.proof_plan!.sha256, head: genesis.baseline.revision },
    { receipt_id: preparedId },
  );
  const review = { ...original, source: { ...original.source, ref: 'refs/heads/main' } };
  expect(review.source.head_sha).not.toBe(review.pull_request.head_sha);
  const verify = async (artifact: typeof review, preparationInput = prepared) => {
    const verify = async () => ({
      ...(await verifiedSigner('review', artifact)()),
      certificateIdentity: trustPolicy('review', 'threadloop.yml', 'main').certificate_identity,
    });
    return verifyWorkflowSignedSource(rawPackage(signedReviewPackage(artifact)), genesis, preparationInput, verify);
  };
  const projections = async (artifact: typeof review) =>
    projectWorkflowSignedSource(await verify(artifact), genesis, prepared).payloads;
  expect(await projections(review)).toMatchObject([
    { type: 'review', outcome: 'clean' },
    { type: 'human_approval', scope: 'current_subject', approver: { id: 'user-1' } },
  ]);
  const changed = { ...review, review: { ...review.review, decision: 'CHANGES_REQUESTED' as const, approvals: [] } };
  const merged = { ...changed, pull_request: { ...review.pull_request, merged: true, merged_at: review.observed_at } };
  expect(await projections(merged)).toEqual([
    { type: 'review', outcome: 'changes_required', findings: [] },
    { type: 'completion_observed', kind: 'merge', destination: merged.pull_request.url },
  ]);
  const approved = review.review.approvals[0]!;
  for (const replacement of [{ actor_id: 'other' }, { actor_type: 'Bot' }, { commit_sha: review.source.head_sha }]) {
    const payloads = await projections({
      ...review,
      review: { ...review.review, approvals: [{ ...approved, ...replacement }] },
    });
    expect(payloads.every((payload) => payload.type !== 'human_approval')).toBe(true);
  }
  await expect(verify({ ...review, pull_request: { ...review.pull_request, base_ref: 'other' } })).rejects.toThrow();
  await expect(
    verify({ ...review, source: { ...review.source, run_invocation_uri: 'github-run-123' } }),
  ).rejects.toThrow();
  await expect(
    verify({ ...review, pull_request: { ...review.pull_request, head_sha: review.source.head_sha } }),
  ).rejects.toThrow();
  const instructionTarget = preparation(genesis, {
    kind: 'signed-instruction',
    pr: 42,
    instruction: { purpose: 'request_stop', reason: 'Stop this run.' },
  });
  const withdrawn = await verify(changed, instructionTarget);
  expect(withdrawn).toMatchObject({ kind: 'signed-instruction', objects: [] });
  expect(projectWorkflowSignedSource(withdrawn, genesis, instructionTarget)).toMatchObject({
    payloads: [],
    applicable_version: 3,
  });
  await expect(verify(review, instructionTarget)).rejects.toMatchObject({ details: { reason: 'instruction_proof' } });
});
