import { execFile, execFileSync } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ThreadloopError } from '../contracts/errors.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { verifiedQodoReview } from '../domain/workflow-qodo-review.js';
import { sha256 } from '../adapters/crypto/sha256.js';
import { readGaapFile, requireGaapDirectory } from '../adapters/fs/gaap-files.js';
import {
  captureCollection,
  finishCollection,
  openCollection,
  type CollectionTarget,
} from '../adapters/fs/workflow-collection-store.js';
import type { HostSource, RunSnapshot, SourceBinding } from '../domain/workflow-run.js';
import { observeWorkflow } from './workflow-observation.js';
import { projectWorkflowHostSource } from './workflow-host-source.js';
import { assertWorkflowReviewReader } from './workflow-gaap-adapter.js';
import { produceLocalGate } from './local-gate.js';
import { workflowStoreFor } from './workflow-access.js';
import { admitWorkflowHostSource } from './workflow-runtime.js';

const readStatus = promisify(execFile);
function reject(message: string): never {
  throw new ThreadloopError('TRANSITION_GUARD_FAILED', message, {
    details: { reason: 'invalid_producer', hint: 'Inspect the enrolled source, current subject and producer output.' },
  });
}
function bytes(content: Uint8Array) {
  return { bytes: content, sha256: sha256(content) };
}
function sourceBinding(snapshot: RunSnapshot, kind: CollectionTarget['kind']): SourceBinding {
  const observed = observeWorkflow(snapshot),
    v = snapshot.view;
  const policy = snapshot.genesis.source_policies[kind];
  if (
    !policy ||
    !snapshot.history.proof_plan_bound ||
    !observed.physical?.clean ||
    observed.facts.status !== 'verified' ||
    observed.physical.branch !== snapshot.genesis.baseline_branch
  )
    reject('The producer requires an enrolled source, bound plan and clean subject on the adopted branch.');
  return {
    binding: {
      workflow_run_id: v.workflow_run_id,
      graph_schema_version: v.graph_schema_version,
      graph_digest: v.graph_digest,
      source_state: v.state,
      state_version: v.state_version,
      subject: observed.subject,
    },
    branch: observed.physical.branch,
    workflow_policy: v.policy,
    evidence_policy: policy,
  };
}
function reviewTree(snapshot: RunSnapshot, base: string, head: string) {
  const git = (...args: string[]) =>
    execFileSync('git', ['--no-replace-objects', '--no-optional-locks', '-C', snapshot.genesis.subject_root, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 8192,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_NO_LAZY_FETCH: '1',
        GIT_ALLOW_PROTOCOL: '',
      },
    }).trim();
  if (git('merge-base', base, head) !== base || base === head)
    reject('The enrolled review base must be an ancestor of the current head.');
  return git('rev-parse', '--verify', head + '^{tree}');
}
async function retainedReview(snapshot: RunSnapshot, producing: SourceBinding, operation: string): Promise<HostSource> {
  const reader =
    snapshot.genesis.setup.schema_version === 'threadloop.workflow-setup/2' && snapshot.genesis.setup.review_reader;
  if (!reader) reject('A pre-PR review requires an enrolled Qodo status reader.');
  const subject = producing.binding.subject;
  if (subject.kind !== 'repository') reject('A pre-PR review requires a repository subject.');
  if (observeWorkflow(snapshot).origin !== snapshot.genesis.setup.repository_id)
    reject('The checkout origin differs from the enrolled review repository.');
  const tree = reviewTree(snapshot, reader.base_commit, subject.revision);
  const executable = assertWorkflowReviewReader(snapshot.genesis).executable;
  const { stdout } = await readStatus(executable, ['review', 'status', operation, '--json'], {
    cwd: snapshot.genesis.subject_root,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'buffer',
  });
  assertWorkflowReviewReader(snapshot.genesis);
  const {
    run_id,
    observed_at: measured,
    outcome,
    findings,
    details,
  } = verifiedQodoReview(stdout, reader.base_commit, subject.revision, tree);
  const artifact = bytes(
    Buffer.from(
      canonicalJson({
        provider: 'qodo',
        operation,
        run_id,
        repository_id: snapshot.genesis.setup.repository_id,
        reviewer_id: reader.reviewer_id,
        head_sha: subject.revision,
        base_sha: reader.base_commit,
        tree_sha: tree,
        observed_at: measured,
        outcome,
        findings,
        status_base64: stdout.toString('base64'),
        status_sha256: sha256(stdout),
      }),
    ),
  );
  return {
    kind: 'pre-pr-review',
    producing,
    producer_id: producing.evidence_policy,
    reviewer_id: reader.reviewer_id,
    observed_at: measured,
    artifact,
    findings,
    review: {
      outcome,
      headSha: subject.revision,
      evidenceRef: 'qodo:' + operation,
      evidenceSha256: artifact.sha256,
      findings: details,
    },
  };
}
async function localGate(
  root: string,
  snapshot: RunSnapshot,
  producing: SourceBinding,
  gateId: string,
  attempt: string,
): Promise<HostSource> {
  const plan = snapshot.genesis.proof_plan;
  const gate = plan?.plan.gates.find((g) => g.id === gateId);
  if (!plan || !gate || !snapshot.genesis.policy.rules.local_gate_ids.includes(gateId))
    reject('The gate must be declared by the adopted local proof plan.');
  const baseline = producing.binding.subject;
  if (baseline.kind !== 'repository') reject('A local gate requires a repository subject.');
  const directory = path.join(root, '.threadloop', 'artifacts', 'workflow-collections', attempt);
  let parent = path.join(root, '.threadloop');
  requireGaapDirectory(parent);
  for (const segment of ['artifacts', 'workflow-collections']) {
    parent = path.join(parent, segment);
    try {
      await mkdir(parent, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    requireGaapDirectory(parent);
    const info = await lstat(parent);
    if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
      reject('Gate artifacts require an owned control directory.');
  }
  await mkdir(directory, { mode: 0o700 });
  const observe = () => {
    const observed = observeWorkflow(snapshot);
    if (!observed.physical || observed.subject.kind !== 'repository') return null;
    const same = canonicalJson(baseline) === canonicalJson(observed.subject);
    return {
      headSha: observed.subject.revision,
      clean: observed.physical.clean && same,
      branch: observed.physical.branch,
      changedFiles: [],
    };
  };
  const before = observe();
  if (!before?.clean) reject('The physical subject changed before starting the gate.');
  const receiptId = 'receipt_' + attempt;
  const result = await produceLocalGate({
    repoRoot: snapshot.genesis.subject_root,
    artifactRoot: directory,
    receiptDirectory: directory,
    receiptId,
    sessionId: snapshot.view.workflow_run_id,
    planSha256: plan.sha256,
    gate,
    before,
    observeLocal: () => Promise.resolve(observe()),
    limits: {
      env: { PATH: process.env.PATH, LANG: 'C' },
      maxOutputBytes: Math.floor((8 * 1024 * 1024) / (2 + 2 * (gate.setup?.length ?? 0))),
    },
  });
  const payload = result.receipt;
  return {
    kind: 'local-gate',
    producing,
    producer_id: producing.evidence_policy,
    artifact: bytes(result.executionBytes),
    outputs: result.outputs.map((output) => ({
      path: output.path,
      content: bytes(readGaapFile(path.join(directory, output.path), output.bytes)),
    })),
    receipt: {
      sequence: 1,
      id: receiptId,
      sessionId: payload.session_id,
      gateId,
      planSha256: plan.sha256,
      headBefore: payload.head_before,
      headAfter: payload.head_after,
      result: payload.result,
      artifactPath: payload.artifact.path,
      artifactSha256: payload.artifact.sha256,
      receiptJson: result.receiptJson,
      receiptSha256: sha256(result.receiptJson),
      stateVersion: snapshot.view.state_version,
      createdAt: payload.ended_at,
    },
  };
}
export interface CollectOptions {
  run: string;
  gate?: string;
  operation?: string;
  expectedStateVersion: number;
  idempotencyKey: string;
}
export async function collectWorkflowEvidence(cwd: string, kind: string, o: CollectOptions) {
  if (kind !== 'local-gate' && kind !== 'pre-pr-review') reject('Choose local-gate or pre-pr-review.');
  const target =
    kind === 'local-gate' && o.operation === undefined
      ? o.gate
      : kind === 'pre-pr-review' && o.gate === undefined
        ? o.operation
        : undefined;
  if (!target || (kind === 'pre-pr-review' && !z.uuid().safeParse(target).success))
    reject('Supply the declared gate ID or the Qodo review operation UUID.');
  const { root, store } = await workflowStoreFor(cwd, o.run);
  store.read(o.run);
  const opened = openCollection(
    root,
    o.run,
    o.idempotencyKey,
    { kind, target, state_version: o.expectedStateVersion },
    (snapshot) => {
      if (kind === 'pre-pr-review') assertWorkflowReviewReader(snapshot.genesis);
      else if (
        !snapshot.genesis.proof_plan?.plan.gates.some((g) => g.id === target) ||
        !snapshot.genesis.policy.rules.local_gate_ids.includes(target)
      )
        reject('The local proof plan has no such gate.');
      return sourceBinding(snapshot, kind).binding.subject.content_digest;
    },
  );
  if (opened.stage === 'completed') return opened.reply;
  let source: HostSource;
  if (opened.stage === 'captured') source = opened.source;
  else {
    try {
      const producing = sourceBinding(opened.snapshot, kind);
      if (producing.binding.subject.content_digest !== opened.intent.subject_digest)
        reject('The subject changed before collection.');
      source =
        kind === 'local-gate'
          ? await localGate(root, opened.snapshot, producing, target, opened.intent.attempt)
          : await retainedReview(opened.snapshot, producing, target);
      projectWorkflowHostSource(source, opened.snapshot.genesis);
    } catch (error) {
      // Qodo status is read-only. The same operation can be collected again after an unavailable response.
      if (
        kind === 'local-gate' ||
        (error instanceof ThreadloopError && error.details?.reason === 'invalid_terminal_review')
      )
        finishCollection(root, o.run, o.idempotencyKey, {
          phase: 'failed',
          reason: 'The producer ended without admissible output. Inspect its attempt ' + opened.intent.attempt + '.',
        });
      if (error instanceof ThreadloopError) throw error;
      reject("The enrolled producer didn't return a verifiable result. Inspect its original operation.");
    }
    const replay = captureCollection(root, o.run, o.idempotencyKey, source);
    if (replay) return replay;
  }
  const reply = await admitWorkflowHostSource(cwd, o.run, o.expectedStateVersion, source).catch((error: unknown) => {
    if (error instanceof ThreadloopError && ['TRANSITION_GUARD_FAILED', 'STATE_VERSION_CONFLICT'].includes(error.code))
      finishCollection(root, o.run, o.idempotencyKey, {
        phase: 'failed',
        reason: 'The captured source no longer matches the run. Collect new evidence at the current subject.',
      });
    throw error;
  });
  finishCollection(root, o.run, o.idempotencyKey, { phase: 'completed', reply });
  return JSON.parse(canonicalJson(reply)) as typeof reply;
}
