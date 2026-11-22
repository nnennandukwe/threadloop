import path from 'node:path';
import { activeWorkflowCollections, guardWorkflowCollections } from '../adapters/fs/workflow-collection-store.js';
import { workflowStoreFor, readWorkflowDecision } from './workflow-access.js';
import { observeWorkflowExecution } from './workflow-execution.js';
import { verifySigstoreReceipt } from '../adapters/crypto/sigstore.js';
import { ThreadloopError } from '../contracts/errors.js';
import { canonicalJson } from '../domain/canonical-json.js';
import type {
  Batch,
  HostSource,
  PrepareTarget,
  RunSnapshot,
  SignedKind,
  SourceBinding,
} from '../domain/workflow-run.js';
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

export async function createWorkflowRun(cwd: string, run: string, profile: string, setup: string) {
  const { root, store } = await workflowStoreFor(cwd, run);
  const genesis = prepareWorkflowGenesis(cwd, run, profile, setup, root);
  return store.create(run, genesis.requestJson, (now) => genesis.build(now));
}

export async function inspectWorkflowRun(cwd: string, run: string) {
  const { root, store } = await workflowStoreFor(cwd, run);
  const snapshot = store.read(run);
  if (!snapshot.genesis.gaap) return snapshot.view;
  const { inspection } = await observeWorkflowExecution(snapshot);
  return { ...snapshot.view, execution: inspection, collections: activeWorkflowCollections(root, run) };
}

export async function decideWorkflowRun(cwd: string, run: string) {
  const { root, store } = await workflowStoreFor(cwd, run);
  const snapshot = store.read(run);
  if (snapshot.genesis.gaap) guardWorkflowCollections(root, run);
  const current = snapshot.managed_execution?.active ? (await observeWorkflowExecution(snapshot)).snapshot : snapshot;
  return decideWorkflow(current, observeWorkflow(current), new Date().toISOString());
}

export async function applyWorkflowRun(cwd: string, run: string, filename: string, key: string) {
  const { root, store } = await workflowStoreFor(cwd, run);
  const proposal = readWorkflowDecision(path.resolve(cwd, filename), run);
  return store.apply(run, key, proposal, (snapshot, now) => {
    if (snapshot.genesis.gaap) guardWorkflowCollections(root, run);
    return applyWorkflow(snapshot, proposal, now);
  });
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
  const { store } = await workflowStoreFor(cwd, options.run);
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
  const { store } = await workflowStoreFor(cwd, options.run);
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
  const { store } = await workflowStoreFor(cwd, run);
  return store.admit(run, version, source, (snapshot, _prepared, now) => {
    checkSourceBinding(snapshot, source.producing);
    const batch = projectWorkflowHostSource(source, snapshot.genesis);
    checkMeasurement(batch, now);
    return batch;
  });
}
