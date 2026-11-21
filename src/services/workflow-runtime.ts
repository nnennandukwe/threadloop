import path from 'node:path';
import { z } from 'zod';
import { verifySigstoreReceipt } from '../adapters/crypto/sigstore.js';
import { readGaapFile } from '../adapters/fs/gaap-files.js';
import { createWorkflowStore } from '../adapters/fs/workflow-store.js';
import { ThreadloopError } from '../contracts/errors.js';
import { canonicalJson, isPlainObject } from '../domain/canonical-json.js';
import { parseGaapJson } from '../domain/gaap-json.js';
import type {
  Batch,
  DecisionReply,
  HostSource,
  PrepareTarget,
  RunSnapshot,
  SignedKind,
  SourceBinding,
} from '../domain/workflow-run.js';
import { assertInitializedReadOnly, resolveRepositoryRoot } from './preconditions.js';
import { applyWorkflow, decideWorkflow, observeWorkflow } from './workflow-evaluation.js';
import { prepareWorkflowGenesis } from './workflow-genesis.js';
import { prepareSensorObservation, readWorkflowInstruction } from './workflow-preparation.js';
import { projectWorkflowSignedSource, readSignedSource, verifyWorkflowSignedSource } from './workflow-signed-source.js';
import { projectWorkflowHostSource } from './workflow-host-source.js';

export interface WorkflowPrepareOptions {
  run: string;
  gate?: string;
  pr?: number;
  instruction?: string;
  expectedStateVersion: number;
  idempotencyKey: string;
}

async function storeFor(cwd: string, run: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(run))
    throw new ThreadloopError(
      'INVALID_ARGUMENT',
      'Use a run ID of 1–160 letters, digits, dots, underscores or hyphens, starting with a letter or digit.',
    );
  const root = await resolveRepositoryRoot(cwd);
  await assertInitializedReadOnly(root);
  return { root, store: createWorkflowStore(root) };
}

export async function createWorkflowRun(cwd: string, run: string, profile: string, setup: string) {
  const { root, store } = await storeFor(cwd, run);
  const genesis = prepareWorkflowGenesis(cwd, run, profile, setup, root);
  return store.create(run, genesis.requestJson, (now) => genesis.build(now));
}

export async function inspectWorkflowRun(cwd: string, run: string) {
  const { store } = await storeFor(cwd, run);
  return store.read(run).view;
}

export async function decideWorkflowRun(cwd: string, run: string) {
  const { store } = await storeFor(cwd, run);
  const snapshot = store.read(run);
  return decideWorkflow(snapshot, observeWorkflow(snapshot), new Date().toISOString());
}

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identity = z.strictObject({ id: z.string().min(1), digest });
const expected = z.strictObject({
  workflow_run_id: z.string().min(1),
  graph_schema_version: z.literal('0.1'),
  graph_digest: digest,
  policy: identity,
  state: z.string().min(1),
  state_version: z.number().int().nonnegative(),
  history_digest: digest,
  evidence_revision: z.number().int().nonnegative(),
  subject: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('repository'),
      repository_id: z.string().min(1),
      revision: z.string().min(1),
      content_digest: digest,
    }),
    z.strictObject({ kind: z.literal('artifact'), artifact_id: z.string().min(1), content_digest: digest }),
  ]),
  evaluation_time: z.iso.datetime({ precision: 3 }),
  input_digest: digest,
  decision_digest: digest,
});

function readDecision(filename: string, run: string): DecisionReply {
  const raw = parseGaapJson(readGaapFile(filename, 4 * 1024 * 1024));
  const result = z
    .strictObject({
      ok: z.literal(true),
      command: z.literal('workflow decide'),
      data: z.strictObject({
        controller_decision: z.strictObject({ decision: z.record(z.string(), z.unknown()), decision_digest: digest }),
        expectation: expected,
      }),
    })
    .safeParse(raw);
  if (
    !result.success ||
    result.data.data.expectation.workflow_run_id !== run ||
    !isPlainObject(result.data.data.controller_decision.decision.binding)
  )
    throw new ThreadloopError('INVALID_ARGUMENT', 'Supply a successful workflow decide response for this run.', {
      details: {
        reason: 'invalid_decision',
        hint: 'Run threadloop workflow decide for this run and save its JSON response.',
      },
    });
  // Every field is compared with the full decision reconstructed by the selector under the writer lock.
  return result.data.data as DecisionReply;
}

export async function applyWorkflowRun(cwd: string, run: string, filename: string, key: string) {
  const { store } = await storeFor(cwd, run);
  const proposal = readDecision(path.resolve(cwd, filename), run);
  return store.apply(run, key, proposal, (snapshot, now) => applyWorkflow(snapshot, proposal, now));
}

function parseKind(kind: string): SignedKind {
  if (kind === 'signed-gate' || kind === 'signed-review' || kind === 'signed-instruction') return kind;
  throw new ThreadloopError('INVALID_ARGUMENT', 'Use signed-gate, signed-review or signed-instruction.');
}

function targetFor(cwd: string, name: string, options: WorkflowPrepareOptions): PrepareTarget {
  const kind = parseKind(name);
  if (kind === 'signed-gate' && options.gate && options.pr === undefined && options.instruction === undefined)
    return { kind, gate_id: options.gate };
  if (kind === 'signed-review' && options.pr && options.gate === undefined && options.instruction === undefined)
    return { kind, pr: options.pr };
  if (kind === 'signed-instruction' && options.pr && options.instruction && options.gate === undefined)
    return { kind, pr: options.pr, instruction: readWorkflowInstruction(path.resolve(cwd, options.instruction)) };
  throw new ThreadloopError(
    'INVALID_ARGUMENT',
    'Supply --gate for a signed gate, --pr for a signed review, or --pr and --instruction for a signed instruction.',
  );
}

export async function prepareWorkflowEvidence(cwd: string, kind: string, options: WorkflowPrepareOptions) {
  const { store } = await storeFor(cwd, options.run);
  const target = targetFor(cwd, kind, options);
  return store.prepare(options.run, options.idempotencyKey, options.expectedStateVersion, target, (snapshot, id, now) =>
    prepareSensorObservation(snapshot, observeWorkflow(snapshot), target, id, now),
  );
}

function checkSourceBinding(snapshot: RunSnapshot, source: SourceBinding) {
  const observed = observeWorkflow(snapshot);
  if (
    observed.facts.status !== 'verified' ||
    !observed.physical?.clean ||
    observed.physical.branch !== source.branch ||
    canonicalJson(observed.subject) !== canonicalJson(source.binding.subject) ||
    source.binding.workflow_run_id !== snapshot.view.workflow_run_id ||
    source.binding.graph_digest !== snapshot.view.graph_digest ||
    source.binding.graph_schema_version !== snapshot.view.graph_schema_version ||
    source.binding.state_version > snapshot.view.state_version ||
    canonicalJson(source.workflow_policy) !== canonicalJson(snapshot.view.policy)
  )
    throw new ThreadloopError(
      'TRANSITION_GUARD_FAILED',
      'The source no longer matches the current run and clean subject.',
      {
        details: {
          reason: 'stale_source_binding',
          hint: 'Restore the original bound checkout or prepare fresh evidence for the current subject.',
        },
      },
    );
}

function checkMeasurement(batch: Batch, now: string) {
  if (batch.measured_at > now || (batch.valid_until !== null && now >= batch.valid_until))
    throw new ThreadloopError('TRANSITION_GUARD_FAILED', 'The observation falls outside its validity interval.', {
      details: { reason: 'stale_measurement', hint: 'Collect a fresh observation for the current subject.' },
    });
}

export async function importWorkflowEvidence(
  cwd: string,
  name: string,
  options: { run: string; source: string; expectedStateVersion: number },
  verifier: typeof verifySigstoreReceipt = verifySigstoreReceipt,
) {
  const { store } = await storeFor(cwd, options.run);
  const kind = parseKind(name);
  const { raw, preparedId } = await readSignedSource(path.resolve(cwd, options.source), kind);
  const lookup = store.lookupSigned(options.run, kind, raw, preparedId);
  if (lookup.kind === 'replay') return lookup.result;
  const verified = await verifyWorkflowSignedSource(raw, lookup.genesis, lookup.prepared, verifier);
  return store.admit(options.run, options.expectedStateVersion, verified, (snapshot, prepared, now) => {
    if (
      !prepared ||
      prepared.prepared_id !== preparedId ||
      prepared.target.kind !== kind ||
      prepared.valid_until <= now ||
      (kind === 'signed-instruction' && prepared.binding.state_version !== snapshot.view.state_version)
    )
      throw new ThreadloopError(
        'TRANSITION_GUARD_FAILED',
        'The preparation is missing, expired or belongs to another state.',
        {
          details: { reason: 'stale_preparation', hint: 'Prepare a new observation and collect a new signed package.' },
        },
      );
    checkSourceBinding(snapshot, prepared);
    const batch = projectWorkflowSignedSource(verified, snapshot.genesis, prepared);
    if (batch.measured_at < prepared.prepared_at)
      throw new ThreadloopError('SIGNED_RECEIPT_CONFLICT', 'The signed observation predates its preparation.');
    checkMeasurement(batch, now);
    return batch;
  });
}

/** Trusted producer entry point. CLI uploads must go through the signed sensor operation. */
export async function admitWorkflowHostSource(cwd: string, run: string, version: number, source: HostSource) {
  const { store } = await storeFor(cwd, run);
  return store.admit(run, version, source, (snapshot, _prepared, now) => {
    checkSourceBinding(snapshot, source.producing);
    const batch = projectWorkflowHostSource(source, snapshot.genesis);
    checkMeasurement(batch, now);
    return batch;
  });
}
