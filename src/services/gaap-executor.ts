import { mkdirSync, mkdtempSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  validateControllerDecision,
  validateControllerInput,
  type ControllerInput,
} from 'threadloop-contracts/controller';
import {
  applyExecutionOperation,
  createExecutionJournal,
  executionAdmissionDigest,
  projectExecution,
  replayExecutionJournal,
  requestReference,
  type ExecutionContext,
  type ExecutionJournal,
  type ExecutionProjection,
  type ExecutionOperation,
  type ReceiptAdmission,
} from 'threadloop-contracts/execution';
import {
  buildGaapRequest,
  canonicalExecutorJson,
  executorRequestAdmissionDigest,
  mapGaapResult,
  parseExecutorMessage,
  validateExecutorContext,
  validateExecutorRequest,
  validateExecutorResult,
  type ExecutorRequest,
  type ExecutorResult,
} from 'threadloop-contracts/executor';
import { VerifiedGaapEnvelope } from '../adapters/crypto/gaap-dsse.js';
import { sha256 } from '../adapters/crypto/sha256.js';
import { observeGaapWorkspace, readGaapFile, requireGaapDirectory } from '../adapters/fs/gaap-files.js';
import {
  GaapState,
  GaapStateCommittedError,
  GaapStateCommitUncertainError,
  type GaapRoot,
  type ManagedGaapOwner,
} from '../adapters/fs/gaap-state.js';
import { runGaapProcess } from '../adapters/process/gaap-runner.js';
import { canonicalJson } from '../domain/canonical-json.js';
import {
  gaapVerificationPolicy,
  parseGaapBinding,
  parseGaapHost,
  type GaapBinding,
  type GaapHost,
} from '../domain/gaap-binding.js';
import { gaapContentDigest } from '../domain/gaap-content.js';
import { canonicalGaapJson, GaapEvidenceError } from '../domain/gaap-json.js';
import { verifyGaapStatement } from '../domain/gaap-statement.js';

type Checked<T> = { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string; message: string }[] };
function checked<T>(result: Checked<T>): T {
  if (!result.ok)
    throw new GaapEvidenceError(
      'executor.contract',
      result.diagnostics.map((item) => item.code + ': ' + item.message).join(' '),
    );
  return result.value;
}
function same(left: unknown, right: unknown) {
  return canonicalJson(left) === canonicalJson(right);
}
function authority(root: Pick<GaapRoot, 'authority'>) {
  const approved = new Set(root.authority);
  return { isAdmitted: (digest: string) => approved.has(digest) };
}
function admit(root: Pick<GaapRoot, 'authority'>, digest: string) {
  if (!root.authority.includes(digest)) root.authority.push(digest);
}
function project(root: GaapRoot, snapshot: ControllerInput) {
  admit(
    root,
    executionAdmissionDigest({ kind: 'projection', execution_digest: root.journal.execution_digest, snapshot }),
  );
  return checked(projectExecution(root.journal, snapshot, authority(root)));
}
function operate(
  root: GaapRoot,
  snapshot: ControllerInput,
  command: ExecutionOperation['command'],
  admissions: ReceiptAdmission[] = [],
) {
  const projection = project(root, snapshot);
  const actor: ExecutionContext['actor'] = { kind: 'executor', executor: root.binding.executor };
  const context: ExecutionContext = { snapshot, actor, recovery_evidence: [], receipt_admissions: admissions };
  const policy = root.binding.execution_policy;
  const operation: ExecutionOperation = {
    schema_version: '0.1',
    id: randomUUID(),
    request: requestReference(root.binding.action_request),
    binding: root.binding.action_request.request.binding,
    execution_policy: { id: policy.id, digest: policy.digest },
    actor,
    expected_revision: projection.projection.revision,
    expected_execution_digest: root.journal.execution_digest,
    command,
  };
  admit(
    root,
    executionAdmissionDigest({
      kind: 'operation',
      execution_digest: root.journal.execution_digest,
      context,
      operation,
    }),
  );
  const result = checked(applyExecutionOperation(root.journal, context, operation, authority(root)));
  if (result.result.disposition !== 'applied') throw new GaapEvidenceError('executor.operation', result.result.code);
  root.journal = result.journal;
  return result;
}
function nowSnapshot(root: GaapRoot, now: string): ControllerInput {
  const snapshot = structuredClone(root.binding.snapshot);
  snapshot.evaluation_time = now;
  checked(validateControllerInput(snapshot));
  return snapshot;
}
function physicalSubject(root: GaapRoot) {
  const observation = observeGaapWorkspace(root.host.workspace);
  const initial = root.binding.action_request.request.binding.subject;
  if (initial.kind !== 'repository')
    throw new GaapEvidenceError('executor.subject', 'This reference bridge requires a Git repository subject.');
  if (observation.revision !== initial.revision)
    throw new GaapEvidenceError('executor.revision', 'The Git revision changed during this bounded Attempt.');
  return { ...observation, subject: { ...initial, content_digest: observation.digest } };
}

/** Explicit host adoption of fresh inputs. No executor output can call this path. */
export function registerGaapExecutor(
  store: GaapState,
  bindingValue: unknown,
  hostValue: unknown,
  now = new Date().toISOString(),
) {
  return register(store, bindingValue, hostValue, now);
}
export type { ManagedGaapOwner } from '../adapters/fs/gaap-state.js';
export type ManagedGaapFence = <T>(phase: 'start' | 'admit', commit: () => T) => T;

export function registerManagedGaapExecutor(
  store: GaapState,
  owner: ManagedGaapOwner,
  binding: GaapBinding,
  host: GaapHost,
  now = new Date().toISOString(),
) {
  return register(store, binding, host, now, owner);
}
function register(store: GaapState, bindingValue: unknown, hostValue: unknown, now: string, owner?: ManagedGaapOwner) {
  const binding = parseGaapBinding(bindingValue);
  const host = parseGaapHost(hostValue);
  const workspace = requireGaapDirectory(host.workspace);
  if (
    !path.isAbsolute(host.executable) ||
    host.workspace !== workspace ||
    binding.parameters.subject_locator !== workspace ||
    store.directory === workspace ||
    store.directory.startsWith(workspace + path.sep) ||
    workspace.startsWith(store.directory + path.sep)
  )
    throw new GaapEvidenceError(
      'executor.paths',
      'Select an absolute executable, exact workspace locator and a separate state directory outside the subject.',
    );
  if (Object.keys(host.environment).some((name) => name.startsWith('THREADLOOP_GAAP_')))
    throw new GaapEvidenceError(
      'executor.environment',
      'THREADLOOP_GAAP_ names are reserved for the host evidence handoff.',
    );
  const policy = gaapVerificationPolicy(host);
  if (!binding.snapshot.policy.rules.evidence_policies.some((entry) => same(entry, policy)))
    throw new GaapEvidenceError(
      'executor.policy',
      'The adopted Workflow policy must explicitly trust this exact host verification policy.',
    );
  const reference = requestReference(binding.action_request);
  if (
    owner &&
    (owner.workflow_run_id !== binding.action_request.request.binding.workflow_run_id ||
      !owner.reservation_id ||
      owner.request_digest !== reference.request_digest)
  )
    throw new GaapEvidenceError(
      'state.owner',
      'The owning Workflow Run and reservation must identify the selected request.',
    );
  const occupied = owner
    ? binding.snapshot.existing_requests.some((item) => item.idempotency_key === reference.idempotency_key)
    : binding.snapshot.existing_requests.length || binding.snapshot.invalidated_claims.length;
  if (binding.snapshot.execution.status !== 'idle' || occupied)
    throw new GaapEvidenceError('executor.fresh', 'Register a fresh idle action with no imported execution authority.');
  const controller = binding.snapshot.policy.rules.authorities.find((entry) => entry.type === 'threadloop');
  if (!controller)
    throw new GaapEvidenceError('executor.authority', 'The Workflow policy requires a ThreadLoop authority identity.');
  const snapshot = owner ? structuredClone(binding.snapshot) : binding.snapshot;
  snapshot.evaluation_time = now;
  const context: ExecutionContext = {
    snapshot,
    actor: { kind: 'threadloop', identity: controller.identity },
    recovery_evidence: [],
    receipt_admissions: [],
  };
  const root: GaapRoot = {
    ...(owner
      ? { schema_version: 'threadloop.gaap-state/2' as const, owner, launch_digest: null, observation_digest: null }
      : { schema_version: 'threadloop.gaap-state/1' as const }),
    revision: 0,
    binding,
    host,
    authority: [],
    journal: null as unknown as ExecutionJournal,
    request: null as unknown as ExecutorRequest,
  };
  const observed = physicalSubject(root);
  if (!same(observed.subject, binding.action_request.request.binding.subject))
    throw new GaapEvidenceError(
      'executor.subject',
      'The adopted request must match the current physical workspace and Git revision.',
    );
  admit(
    root,
    executionAdmissionDigest({
      kind: 'create',
      context,
      request: binding.action_request,
      policy: binding.execution_policy,
    }),
  );
  root.journal = checked(
    createExecutionJournal(context, binding.action_request, binding.execution_policy, authority(root)),
  );
  const requestedDeadline = Date.parse(now) + binding.lease_ms;
  const actionDeadline = binding.action_request.request.constraints.valid_until;
  const validUntil = new Date(
    Math.min(requestedDeadline, actionDeadline ? Date.parse(actionDeadline) : Infinity),
  ).toISOString();
  const granted = operate(root, snapshot, {
    kind: 'acquire',
    claim_id: randomUUID(),
    attempt_id: randomUUID(),
    executor: binding.executor,
    valid_until: validUntil,
  });
  if (!granted.result.claim || !granted.result.attempt_id)
    throw new GaapEvidenceError('executor.claim', 'The host failed to acquire its fresh claim.');
  root.request = registeredRequest(binding, granted.result.claim, granted.result.attempt_id);
  checked(buildGaapRequest(root.request, binding.mapping_policy));
  admit(root, executorRequestAdmissionDigest(root.request));
  store.initialize(root);
  return { request: root.request, revision: root.revision };
}
function registeredRequest(binding: GaapBinding, claim: ExecutorRequest['request']['claim'], attemptId: string) {
  const request = {
    schema_version: 'threadloop.executor/0.1' as const,
    kind: 'execute' as const,
    action_request: binding.action_request,
    execution_policy: { id: binding.execution_policy.id, digest: binding.execution_policy.digest },
    claim,
    attempt_id: attemptId,
    executor: binding.executor,
    mapping_policy: { id: binding.mapping_policy.policy.id, digest: binding.mapping_policy.policy_digest },
    parameters: binding.parameters,
  };
  return checked(validateExecutorRequest({ request, request_digest: sha256(canonicalJson(request)) }));
}

export async function runGaapExecutor(store: GaapState, abortSignal?: AbortSignal) {
  return run(store, abortSignal);
}

interface ManagedAccess {
  owner: ManagedGaapOwner;
  fence: ManagedGaapFence;
}

export async function runManagedGaapExecutor(
  store: GaapState,
  owner: ManagedGaapOwner,
  fence: ManagedGaapFence,
  abortSignal?: AbortSignal,
) {
  return run(store, abortSignal, { owner, fence });
}

function fenced<T>(access: ManagedAccess | undefined, phase: 'start' | 'admit', commit: () => T) {
  if (!access) return commit();
  let child: { value: T } | undefined;
  try {
    access.fence(phase, () => {
      if (child) throw new GaapEvidenceError('state.fenced', 'The Workflow Run already used this child commit.');
      child = { value: commit() };
      return child.value;
    });
  } catch (error) {
    // The outer transaction can't undo a child commit whose acknowledgement got lost.
    if (child) throw new GaapStateCommittedError(error);
    throw error;
  }
  if (!child) throw new GaapEvidenceError('state.fenced', 'The owning Workflow Run withheld the child commit.');
  return child.value;
}

async function run(store: GaapState, abortSignal?: AbortSignal, access?: ManagedAccess) {
  const retained = access ? store.inspect(access.owner) : undefined;
  if (retained) await verifyGaapSnapshot(retained, store.directory);
  const registered = retained?.root ?? store.read();
  const registeredProjection = checked(replayExecutionJournal(registered.journal, authority(registered)));
  if (registeredProjection.attempts.at(-1)?.status !== 'pending')
    throw new GaapEvidenceError(
      'executor.launched',
      'This Attempt has already started. Inspect and reconcile it before any new execution.',
    );
  const outputs = path.join(store.directory, 'outputs');
  try {
    mkdirSync(outputs, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  requireGaapDirectory(outputs);
  const outputDirectory = mkdtempSync(path.join(outputs, 'attempt-'));
  let launched: GaapRoot;
  try {
    launched = fenced(access, 'start', () =>
      store.mutate(
        registered.revision,
        (root, database) => {
          if (!same(physicalSubject(root).subject, root.binding.action_request.request.binding.subject))
            throw new GaapEvidenceError('executor.subject', 'The workspace changed before dispatch.');
          const snapshot = nowSnapshot(root, new Date().toISOString());
          operate(root, snapshot, {
            kind: 'start',
            claim: root.request.request.claim,
            attempt_id: root.request.request.attempt_id,
          });
          project(root, snapshot);
          checked(validateExecutorContext(root.request, root.journal, snapshot, authority(root)));
          database
            .prepare('INSERT INTO launch VALUES (?,?,?)')
            .run(root.request.request.attempt_id, root.request.request_digest, outputDirectory);
          if (root.schema_version === 'threadloop.gaap-state/2')
            root.launch_digest = sha256(
              canonicalJson({
                attempt: root.request.request.attempt_id,
                request_digest: root.request.request_digest,
                output_directory: outputDirectory,
              }),
            );
          store.hit('dispatch.before_commit');
          return structuredClone(root);
        },
        access?.owner,
      ),
    );
  } catch (error) {
    // A committed launch owns this path even if reporting its commit failed.
    if (!(error instanceof GaapStateCommittedError) && !(error instanceof GaapStateCommitUncertainError)) {
      try {
        rmdirSync(outputDirectory);
      } catch (cleanupError) {
        throw new GaapEvidenceError(
          'executor.cleanup',
          `${error instanceof Error ? error.message : String(error)} Retained output directory ${outputDirectory}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    throw error;
  }
  // The launch intent and started journal are durable before this call can spawn.
  store.hit('dispatch.after_commit');
  const replay = checked(replayExecutionJournal(launched.journal, authority(launched)));
  const claim = replay.claims.at(-1)!;
  const remainingLease = Date.parse(claim.valid_until) - Date.now();
  const dispatchSignal = remainingLease <= 0 ? AbortSignal.abort() : abortSignal;
  const transport = await runGaapProcess({
    executable: launched.host.executable,
    arguments: launched.host.arguments,
    cwd: launched.host.workspace,
    environment: { ...launched.host.environment, THREADLOOP_GAAP_EVIDENCE_DIRECTORY: outputDirectory },
    request: launched.request,
    timeoutMs: Math.max(1, Math.min(launched.host.timeout_ms, remainingLease)),
    ...(dispatchSignal ? { abortSignal: dispatchSignal } : {}),
  });
  let retainedEnvelope: Buffer | null = null;
  let evidenceError: string | null = null;
  try {
    requireGaapDirectory(outputDirectory);
    retainedEnvelope = readGaapFile(path.join(outputDirectory, 'envelope.json'), 6 * 1024 * 1024);
  } catch (error) {
    evidenceError = error instanceof Error ? error.message : String(error);
  }
  const observationId = store.mutate(
    store.read(access?.owner).revision,
    (current, database) => {
      const result = database
        .prepare('INSERT INTO observation(status,stdout,stderr,envelope,metadata) VALUES (?,?,?,?,?)')
        .run(
          transport.status,
          transport.stdout,
          transport.stderr,
          retainedEnvelope,
          canonicalJson({
            evidence_error: evidenceError,
            ...transport,
            stdout: undefined,
            stderr: undefined,
            output_directory: outputDirectory,
            request_digest: launched.request.request_digest,
          }),
        );
      if (current.schema_version === 'threadloop.gaap-state/2') {
        const row = database.prepare('SELECT * FROM observation WHERE id=?').get(result.lastInsertRowid)!;
        current.observation_digest = transportDigest(row);
      }
      store.hit('observation.before_commit');
      return Number(result.lastInsertRowid);
    },
    access?.owner,
  );
  if (transport.status !== 'ok')
    return { status: 'uncertain' as const, observation_id: observationId, reason: transport.status };
  try {
    return await admitOutput(store, observationId, access);
  } catch (error) {
    return {
      status: error instanceof GaapStateCommitUncertainError ? ('uncertain' as const) : ('rejected' as const),
      observation_id: observationId,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Re-import retained bytes after a pre-admission failure; never invokes the executor. */
export async function admitGaapOutput(store: GaapState, observationId: number) {
  return admitOutput(store, observationId);
}

export async function admitManagedGaapOutput(
  store: GaapState,
  owner: ManagedGaapOwner,
  observationId: number,
  fence: ManagedGaapFence,
) {
  return admitOutput(store, observationId, { owner, fence });
}
async function admitOutput(store: GaapState, observationId: number, access?: ManagedAccess) {
  const retained = store.inspect(access?.owner);
  if (access) {
    const { admitted } = await verifyGaapSnapshot(retained, store.directory);
    const matched = admitted.find((fact) => fact.observation_id === observationId);
    if (admitted.length && !matched)
      throw new GaapEvidenceError(
        'executor.observation',
        'The requested observation differs from the registered admission.',
      );
    if (matched)
      return { status: 'already_admitted' as const, observation_id: observationId, source_id: matched.source_id };
  }
  const root = retained.root;
  parseGaapBinding(root.binding);
  parseGaapHost(root.host);
  checked(replayExecutionJournal(root.journal, authority(root)));
  const observation = retained.observations.find((entry) => entry.id === observationId);
  if (
    !observation ||
    observation.status !== 'ok' ||
    typeof observation.metadata !== 'string' ||
    !(observation.stdout instanceof Uint8Array)
  )
    throw new GaapEvidenceError('executor.observation', 'Select a retained successful transport observation.');
  const metadata = JSON.parse(observation.metadata) as {
    output_directory: string;
    request_digest: string;
    startedAt: string;
    finishedAt: string;
  };
  const launch = retained.launches.find((entry) => entry.attempt === root.request.request.attempt_id);
  if (
    !launch ||
    launch.request_digest !== root.request.request_digest ||
    launch.output_directory !== metadata.output_directory ||
    metadata.request_digest !== root.request.request_digest
  )
    throw new GaapEvidenceError('executor.observation', 'The observation must bind the host-owned launch intent.');
  const output = requireGaapDirectory(metadata.output_directory);
  if (path.dirname(output) !== path.join(store.directory, 'outputs'))
    throw new GaapEvidenceError('executor.path', 'Evidence must stay in its host-allocated output directory.');
  if (!(observation.envelope instanceof Uint8Array))
    throw new GaapEvidenceError('executor.envelope', 'The transport retained no bounded envelope bytes.');
  const envelope = Buffer.from(observation.envelope);
  const authenticated = VerifiedGaapEnvelope.verify(
    envelope,
    root.host.verification.keys.map((key) => ({
      keyId: key.key_id,
      publicKey: Buffer.from(key.public_key_hex, 'hex'),
    })),
  );
  const expected = checked(buildGaapRequest(root.request, root.binding.mapping_policy));
  const blobDirectory = requireGaapDirectory(path.join(output, 'blobs'));
  const verified = await verifyGaapStatement(
    authenticated,
    expected,
    { read: (digest, maximum) => Promise.resolve(readGaapFile(path.join(blobDirectory, digest.slice(7)), maximum)) },
    root.host.verification.implementation,
  );
  const candidate = checked(validateExecutorResult(checked(parseExecutorMessage(observation.stdout)), root.request));
  const canonical = checked(canonicalExecutorJson(candidate));
  const text = Buffer.from(observation.stdout).toString();
  if (text !== canonical && text !== canonical + '\n')
    throw new GaapEvidenceError(
      'executor.output',
      'The process must return one canonical ExecutorResult and optional final newline.',
    );
  const finished = candidate.result.attempt_receipt.receipt.finished_at;
  if (finished < metadata.startedAt || finished > metadata.finishedAt || finished > new Date().toISOString())
    throw new GaapEvidenceError('executor.time', 'The reported finish must fall inside the observed process interval.');
  const physical = physicalSubject(root);
  if ('sha256:' + physical.digest !== verified.statement.predicate.observed_subject.digest)
    throw new GaapEvidenceError(
      'executor.subject',
      'The current physical subject differs from the signed observation.',
    );
  const mapped = checked(
    mapGaapResult(
      root.request,
      root.binding.mapping_policy,
      Buffer.from(canonicalGaapJson(verified.statement.predicate.receipt)),
      { finished_at: finished, resulting_subject: physical.subject },
    ),
  );
  if (!same(candidate, mapped))
    throw new GaapEvidenceError(
      'executor.mapping',
      'The returned result differs from the independently mapped signed receipt.',
    );
  const source = candidate.result.source_receipt;
  const previous = retained.accepted.find((entry) => entry.source_id === source.id);
  if (previous) {
    if (
      previous.source_digest !== source.digest ||
      !same(JSON.parse(String(previous.result)), candidate) ||
      !Buffer.from(previous.predicate as Uint8Array).equals(authenticated.payload)
    )
      throw new GaapEvidenceError('executor.conflict', 'Changed evidence reuses an admitted source identity.');
    return { status: 'already_admitted' as const, observation_id: observationId, source_id: source.id };
  }
  store.hit('admission.prepared');
  try {
    fenced(access, 'admit', () =>
      store.mutate(
        root.revision,
        (current, database) => {
          if (!same(physicalSubject(current).subject, physical.subject))
            throw new GaapEvidenceError('executor.subject', 'The workspace changed before admission.');
          const now = new Date().toISOString();
          const snapshot = nowSnapshot(current, now);
          project(current, snapshot);
          checked(validateExecutorContext(current.request, current.journal, snapshot, authority(current)));
          const receipt = candidate.result.attempt_receipt;
          const fact = receipt.receipt;
          const admission: ReceiptAdmission['admission'] = {
            schema_version: '0.1',
            id: randomUUID(),
            request: fact.request,
            binding: fact.binding,
            execution_policy: fact.execution_policy,
            claim: fact.claim,
            attempt_id: fact.attempt_id,
            executor: fact.executor,
            receipt: { id: fact.id, digest: receipt.receipt_digest },
            verification_policy: gaapVerificationPolicy(current.host),
            acceptance: { id: 'gaap_' + source.id, digest: sha256(authenticated.payload) },
            admitted_at: now,
            valid_until: null,
          };
          const acceptedAdmission: ReceiptAdmission = { admission, admission_digest: sha256(canonicalJson(admission)) };
          operate(current, snapshot, { kind: 'submit_receipt', receipt }, [acceptedAdmission]);
          for (const [digest, bytes] of verified.blobs)
            database.prepare('INSERT OR IGNORE INTO blob VALUES (?,?)').run(digest, bytes);
          store.hit('admission.blobs');
          database
            .prepare('INSERT INTO accepted VALUES (?,?,?,?,?,?,?)')
            .run(
              source.id,
              source.digest,
              envelope,
              authenticated.payload,
              canonicalJson(candidate),
              canonicalJson(acceptedAdmission),
              observationId,
            );
          store.hit('admission.result');
        },
        access?.owner,
      ),
    );
  } catch (error) {
    if (error instanceof GaapStateCommittedError)
      return {
        status: 'committed_with_warning' as const,
        observation_id: observationId,
        source_id: source.id,
        warning: error.message,
      };
    throw error;
  }
  // Admission has committed. A later evaluation failure mustn't masquerade as rollback.
  try {
    store.hit('admission.after_commit');
    if (access) return { status: 'admitted' as const, observation_id: observationId, source_id: source.id };
    const evaluation = evaluateGaapController(store);
    return { status: 'admitted' as const, observation_id: observationId, source_id: source.id, evaluation };
  } catch (error) {
    return {
      status: 'committed_with_warning' as const,
      observation_id: observationId,
      source_id: source.id,
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

export function evaluateGaapController(store: GaapState) {
  const root = store.read();
  const snapshot = nowSnapshot(root, new Date().toISOString());
  const projected = project(root, snapshot);
  Object.assign(snapshot, projected.controller);
  const observed = physicalSubject(root);
  snapshot.observation.subject = observed.subject;
  if (snapshot.observation.repository) {
    snapshot.observation.repository.branch = observed.branch;
    snapshot.observation.repository.clean = observed.clean;
    snapshot.observation.repository.relationship = same(snapshot.observation.repository.basis, observed.subject)
      ? 'equal'
      : 'unknown';
  }
  if (projected.projection.request_status === 'satisfied') {
    snapshot.binding.subject = observed.subject;
    // Successful execution history remains in the journal; it doesn't stay an active obligation on the new subject.
    snapshot.existing_requests = [];
  } else {
    // Retain the original request binding while fresh observations fence unresolved effects.
    Object.assign(snapshot, project(root, snapshot).controller);
  }
  checked(validateControllerInput(snapshot));
  const candidates = snapshot.compiled_graph.graph.transitions
    .filter((edge) => edge.from === snapshot.binding.source_state)
    .map((edge) => {
      const decision = {
        schema_version: '0.1',
        binding: snapshot.binding,
        input_digest: sha256(canonicalJson(snapshot)),
        outcome: 'transition_available',
        transition_id: edge.id,
        target_state: edge.to,
        checks: edge.guard_refs.map((guard) => ({
          guard_id: guard,
          evidence_ids: snapshot.receipts.map((receipt) => receipt.id),
        })),
      };
      const result = validateControllerDecision(snapshot, {
        decision,
        decision_digest: sha256(canonicalJson(decision)),
      });
      return {
        transition_id: edge.id,
        target_state: edge.to,
        available: result.ok,
        diagnostics: result.ok ? [] : result.diagnostics,
      };
    });
  const evaluation = {
    evaluated_at: snapshot.evaluation_time,
    workflow_state: snapshot.binding.source_state,
    state_version: snapshot.binding.state_version,
    execution_status: snapshot.execution.status,
    subject: snapshot.binding.subject,
    observed_subject: observed.subject,
    repository: snapshot.observation.repository,
    candidates,
    lifecycle_mutated: false,
  };
  store.mutate(root.revision, (_current, database) => {
    database.prepare('INSERT INTO evaluation(body) VALUES (?)').run(canonicalJson(evaluation));
  });
  return evaluation;
}

type RetainedState = ReturnType<GaapState['inspect']>;
export interface ManagedGaapInspection {
  owner: ManagedGaapOwner;
  revision: number;
  binding_digest: string;
  host_digest: string;
  request: ExecutorRequest;
  journal: ExecutionJournal;
  authority: string[];
  projection: ExecutionProjection;
  launch_count: number;
  observations: { id: number; status: string }[];
  admitted: {
    observation_id: number;
    source_id: string;
    source_digest: string;
    admission: ReceiptAdmission;
    result: ExecutorResult;
  }[];
}
export async function inspectManagedGaapExecutor(
  store: GaapState,
  owner: ManagedGaapOwner,
): Promise<ManagedGaapInspection> {
  const retained = store.inspect(owner);
  const { root } = retained;
  const { projection, admitted } = await verifyGaapSnapshot(retained, store.directory);
  return {
    owner,
    revision: root.revision,
    binding_digest: sha256(canonicalJson(root.binding)),
    host_digest: sha256(canonicalJson(root.host)),
    request: root.request,
    journal: root.journal,
    authority: root.authority,
    projection,
    launch_count: retained.launches.length,
    observations: retained.observations.map((row) => ({ id: Number(row.id), status: String(row.status) })),
    admitted,
  };
}
function transportDigest(row: Record<string, unknown>) {
  if (
    !(row.stdout instanceof Uint8Array) ||
    !(row.stderr instanceof Uint8Array) ||
    (row.envelope !== null && !(row.envelope instanceof Uint8Array))
  )
    throw new GaapEvidenceError(
      'state.observation',
      'The retained process streams and signed envelope must contain their original bytes.',
    );
  return sha256(
    canonicalJson({
      id: row.id,
      status: row.status,
      metadata: row.metadata,
      stdout: sha256(row.stdout),
      stderr: sha256(row.stderr),
      envelope: row.envelope === null ? null : sha256(row.envelope),
    }),
  );
}
function checkManagedRegistration(retained: RetainedState, projection: ExecutionProjection, directory: string) {
  const { root } = retained;
  if (root.schema_version !== 'threadloop.gaap-state/2') return;
  const { binding } = root;
  const journal = root.journal.execution;
  const initial = journal.initial_context.snapshot;
  const claim = projection.claims[0];
  const attempt = projection.attempts[0];
  if (
    !same(journal.action_request, binding.action_request) ||
    !same(journal.execution_policy, binding.execution_policy) ||
    !same(initial, { ...binding.snapshot, evaluation_time: initial.evaluation_time }) ||
    root.owner.workflow_run_id !== binding.action_request.request.binding.workflow_run_id ||
    root.owner.request_digest !== binding.action_request.request_digest ||
    !authority(root).isAdmitted(executorRequestAdmissionDigest(root.request)) ||
    !binding.snapshot.policy.rules.evidence_policies.some((policy) =>
      same(policy, gaapVerificationPolicy(root.host)),
    ) ||
    projection.claims.length !== 1 ||
    projection.attempts.length !== 1 ||
    !claim ||
    !attempt ||
    !same(attempt.claim, { id: claim.id, version: claim.version }) ||
    claim.attempt_id !== attempt.id ||
    !same(root.request, registeredRequest(binding, attempt.claim, attempt.id)) ||
    !same(claim.executor, binding.executor)
  )
    throw new GaapEvidenceError(
      'state.registration',
      'The managed child, selected request, policy, claim and Attempt must match their enrolled identities.',
    );
  const launch = retained.launches[0];
  const observation = retained.observations[0];
  if (
    retained.launches.length !== (attempt.started_at === null ? 0 : 1) ||
    root.launch_digest !== (launch ? sha256(canonicalJson(launch)) : null) ||
    root.observation_digest !== (observation ? transportDigest(observation) : null) ||
    (launch &&
      (launch.attempt !== attempt.id ||
        launch.request_digest !== root.request.request_digest ||
        typeof launch.output_directory !== 'string' ||
        path.dirname(launch.output_directory) !== path.join(directory, 'outputs'))) ||
    retained.observations.length > 1 ||
    (retained.observations.length && !launch) ||
    retained.evaluations.length
  )
    throw new GaapEvidenceError(
      'state.launch',
      'The retained launch must identify the one enrolled Attempt and request.',
    );
  for (const observation of retained.observations) {
    const metadata = JSON.parse(String(observation.metadata)) as Record<string, unknown>;
    if (
      metadata.request_digest !== root.request.request_digest ||
      metadata.output_directory !== launch?.output_directory ||
      metadata.status !== observation.status
    )
      throw new GaapEvidenceError(
        'state.observation',
        'Transport metadata differs from the retained observation or launch.',
      );
  }
}
async function verifyGaapSnapshot(retained: RetainedState, directory: string) {
  parseGaapBinding(retained.root.binding);
  parseGaapHost(retained.root.host);
  const projection = checked(replayExecutionJournal(retained.root.journal, authority(retained.root)));
  checkManagedRegistration(retained, projection, directory);
  const blobs = new Map(retained.blobs.map((entry) => [String(entry.digest), Buffer.from(entry.bytes as Uint8Array)]));
  for (const [digest, bytes] of blobs)
    if (gaapContentDigest(bytes) !== digest)
      throw new GaapEvidenceError('state.blob', 'A retained blob differs from its admitted identity.');
  const expected = checked(buildGaapRequest(retained.root.request, retained.root.binding.mapping_policy));
  const admitted: ManagedGaapInspection['admitted'] = [];
  for (const entry of retained.accepted) {
    const authenticated = VerifiedGaapEnvelope.verify(
      entry.envelope as Uint8Array,
      retained.root.host.verification.keys.map((key) => ({
        keyId: key.key_id,
        publicKey: Buffer.from(key.public_key_hex, 'hex'),
      })),
    );
    if (!authenticated.payload.equals(Buffer.from(entry.predicate as Uint8Array)))
      throw new GaapEvidenceError('state.predicate', 'Stored predicate differs from the signed payload.');
    const verified = await verifyGaapStatement(
      authenticated,
      expected,
      {
        read: (digest) => {
          const bytes = blobs.get(digest);
          if (!bytes) throw new GaapEvidenceError('state.blob', 'An admitted blob is missing.');
          return Promise.resolve(bytes);
        },
      },
      retained.root.host.verification.implementation,
    );
    const result = checked(validateExecutorResult(JSON.parse(String(entry.result)), retained.root.request));
    const receipt = result.result.attempt_receipt.receipt;
    const initialSubject = retained.root.binding.action_request.request.binding.subject;
    if (
      initialSubject.kind !== 'repository' ||
      !same(receipt.resulting_subject, {
        ...initialSubject,
        content_digest: verified.statement.predicate.observed_subject.digest.slice(7),
      })
    )
      throw new GaapEvidenceError(
        'state.subject',
        'The admitted resulting subject must match the signed observation and the original repository and revision.',
      );
    const remapped = checked(
      mapGaapResult(
        retained.root.request,
        retained.root.binding.mapping_policy,
        Buffer.from(canonicalGaapJson(verified.statement.predicate.receipt)),
        { finished_at: receipt.finished_at, resulting_subject: receipt.resulting_subject },
      ),
    );
    const admission = JSON.parse(String(entry.admission)) as ReceiptAdmission;
    const observation = retained.observations.find((row) => row.id === entry.observation_id);
    const launch = retained.launches.find((row) => row.attempt === receipt.attempt_id);
    const metadata = observation ? (JSON.parse(String(observation.metadata)) as Record<string, unknown>) : undefined;
    const encoded = checked(canonicalExecutorJson(result));
    const stdout = observation?.stdout;
    if (
      !observation ||
      observation.status !== 'ok' ||
      !(stdout instanceof Uint8Array) ||
      !(observation.envelope instanceof Uint8Array) ||
      !Buffer.from(observation.envelope).equals(Buffer.from(entry.envelope as Uint8Array)) ||
      ![Buffer.from(encoded), Buffer.from(encoded + '\n')].some((bytes) => bytes.equals(stdout)) ||
      !launch ||
      !metadata ||
      launch.request_digest !== retained.root.request.request_digest ||
      metadata.request_digest !== launch.request_digest ||
      metadata.output_directory !== launch.output_directory ||
      metadata.status !== 'ok' ||
      typeof metadata.startedAt !== 'string' ||
      typeof metadata.finishedAt !== 'string' ||
      !Number.isFinite(Date.parse(metadata.startedAt)) ||
      !Number.isFinite(Date.parse(metadata.finishedAt)) ||
      Date.parse(receipt.finished_at) < Date.parse(metadata.startedAt) ||
      Date.parse(receipt.finished_at) > Date.parse(metadata.finishedAt)
    )
      throw new GaapEvidenceError(
        'state.observation',
        'The accepted result must match its retained launch, process interval, stdout and signed envelope.',
      );
    if (
      !same(remapped, result) ||
      admission.admission_digest !== sha256(canonicalJson(admission.admission)) ||
      admission.admission.acceptance.digest !== sha256(authenticated.payload) ||
      admission.admission.acceptance.id !== 'gaap_' + result.result.source_receipt.id ||
      !same(admission.admission.verification_policy, gaapVerificationPolicy(retained.root.host)) ||
      !retained.root.journal.execution.entries.some((record) =>
        record.context.receipt_admissions.some((fact) => same(fact, admission)),
      )
    )
      throw new GaapEvidenceError(
        'state.admission',
        'Retained evidence, mapped result and admission must match the independently admitted journal entry.',
      );
    if (
      result.result.source_receipt.id !== entry.source_id ||
      result.result.source_receipt.digest !== entry.source_digest ||
      !projection.receipts.some((receipt) => same(receipt.envelope, result.result.attempt_receipt))
    )
      throw new GaapEvidenceError('state.result', 'Stored result is missing its exact admitted journal receipt.');
    admitted.push({
      observation_id: Number(entry.observation_id),
      source_id: result.result.source_receipt.id,
      source_digest: result.result.source_receipt.digest,
      admission,
      result,
    });
  }
  if (projection.receipts.length !== retained.accepted.length)
    throw new GaapEvidenceError(
      'state.incomplete',
      'Every admitted journal receipt requires its retained evidence record.',
    );
  return { projection, admitted };
}

export async function inspectGaapExecutor(store: GaapState) {
  const retained = store.inspectForReport();
  const { projection, admitted } = await verifyGaapSnapshot(retained, store.directory);
  const { root } = retained;
  const managed = root.schema_version === 'threadloop.gaap-state/2';
  return {
    ...(managed
      ? {
          schema_version: 'threadloop.gaap-inspection/2',
          owner: root.owner,
          binding_digest: sha256(canonicalJson(retained.root.binding)),
          host_digest: sha256(canonicalJson(retained.root.host)),
        }
      : { schema_version: 'threadloop.gaap-inspection/1' }),
    revision: retained.root.revision,
    workflow_state: retained.root.binding.snapshot.binding.source_state,
    state_version: retained.root.binding.snapshot.binding.state_version,
    request_digest: retained.root.request.request_digest,
    projection,
    launch_count: retained.launches.length,
    observations: retained.observations.map((entry) => ({ id: entry.id, status: entry.status })),
    admitted: admitted.map(({ source_id, source_digest, observation_id, admission }) => ({
      source_id,
      source_digest,
      ...(managed ? { observation_id, admission_digest: admission.admission_digest } : {}),
    })),
    evaluations: retained.evaluations.map((entry) => JSON.parse(String(entry.body)) as unknown),
  };
}
