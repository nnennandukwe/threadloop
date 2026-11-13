import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalExecutorJson } from 'threadloop-contracts/executor';
import * as execution from 'threadloop-contracts/execution';
import * as controller from 'threadloop-contracts/controller';
import {
  buildActionRequest,
  validateControllerInput,
  type ActionRequest,
  type ControllerInput,
} from 'threadloop-contracts/controller';
import type {
  AttemptReceipt,
  ExecutionContext,
  ExecutionJournal,
  ExecutionOperation,
  ExecutionPolicy,
  ReceiptAdmission,
  RecoveryEvidence,
} from 'threadloop-contracts/execution';
import type { Drift, Observation, Scenario, Step } from './scenario.js';

const epoch = Date.parse('2026-09-10T10:00:00.000Z');
const date = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
const seconds = (time: string) => (Date.parse(time) - epoch) / 1000;
const canonicalJson = (value: unknown) => {
  // Validated projections reuse object identities in memory; the public wire codec requires a JSON tree.
  const wire: unknown = JSON.parse(JSON.stringify(value));
  return checked(canonicalExecutorJson(wire));
};
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const executor = (actor: 'a' | 'b') => ({ id: `executor_${actor}`, incarnation: `process_${actor}` });
const numberOf = (id: string) => Number(id.slice(id.lastIndexOf('_') + 1));
function checked<T>(value: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!value.ok) throw new Error(JSON.stringify(value.diagnostics));
  return value.value;
}
export async function publicSnapshot(name = 'action_required'): Promise<ControllerInput> {
  const asset = (file: string) => new URL(import.meta.resolve('threadloop-contracts/assets/' + file));
  const fixture = JSON.parse(await readFile(asset(`controller-v0.1/fixtures/valid/${name}.json`), 'utf8')) as {
    input: ControllerInput;
  };
  // Only normalized input crosses the adapter. Expected decisions and fixture metadata stay outside it.
  const input = fixture.input;
  input.compiled_graph = JSON.parse(
    await readFile(asset('workflow-graph-v0.1/fixtures/valid/governed-pr.compiled.json'), 'utf8'),
  ) as ControllerInput['compiled_graph'];
  input.evaluation_time = date(0);
  return checked(validateControllerInput(input));
}
export class ControllerAdapter {
  private time = 0;
  private drift: Drift = 'none';
  private admissions = new Set<string>();
  private attempted: { context: ExecutionContext; operation: ExecutionOperation }[] = [];
  private deliveries = new Map<number, { context: ExecutionContext; operation: ExecutionOperation }>();
  private reports = new Map<number, AttemptReceipt>();
  private reportAdmissions = new Map<number, ReceiptAdmission[]>();
  private constructor(
    private api: typeof execution,
    private base: ControllerInput,
    private journal: ExecutionJournal,
    private controllerApi: typeof controller,
  ) {}
  private authority = { isAdmitted: (digest: string) => this.admissions.has(digest) };

  static async create(scenario: Scenario, api = execution, controllerApi = controller) {
    const base = await publicSnapshot();
    const request = checked(
      buildActionRequest(base, {
        action_id: 'run_gates',
        transition_id: 'human_handoff',
        guard_ids: ['review_set'],
        inputs: [{ role: 'proof_plan', artifact: base.policy.rules.proof_plan }],
        evidence_ids: [],
        evidence_requirements: [{ family: 'local_proof', guard_id: 'review_set', subject: base.binding.subject }],
        valid_until: null,
      }),
    );
    const context: ExecutionContext = {
      snapshot: base,
      actor: {
        kind: 'threadloop',
        identity: base.policy.rules.authorities.find((entry) => entry.type === 'threadloop')!.identity,
      },
      recovery_evidence: [],
      receipt_admissions: [],
    };
    const rules: ExecutionPolicy['rules'] = {
      request: api.requestReference(request),
      workflow_policy: request.request.policy,
      retry_safety: scenario.retry,
      max_attempts: 8,
    };
    const policy: ExecutionPolicy = { id: 'generated_execution', digest: hash(rules), rules };
    const adapter = new ControllerAdapter(api, base, null as unknown as ExecutionJournal, controllerApi);
    adapter.admissions.add(api.executionAdmissionDigest({ kind: 'create', context, request, policy }));
    adapter.journal = checked(api.createExecutionJournal(context, request, policy, adapter.authority));
    return adapter;
  }
  private snapshot() {
    const snapshot = structuredClone(this.base);
    snapshot.evaluation_time = date(this.time);
    if (this.drift === 'subject') {
      snapshot.binding.subject.content_digest = hash('changed subject');
      snapshot.observation.subject = snapshot.binding.subject;
      if (snapshot.observation.repository) snapshot.observation.repository.relationship = 'unknown';
    } else if (this.drift === 'state') {
      snapshot.binding.state_version++;
      snapshot.observation.state_version++;
    } else if (this.drift === 'graph') {
      snapshot.compiled_graph.graph.profile.revision++;
      snapshot.compiled_graph.graph_digest = hash(snapshot.compiled_graph.graph);
      snapshot.binding.graph_digest = snapshot.compiled_graph.graph_digest;
    } else if (this.drift === 'policy') {
      snapshot.policy.rules.local_gate_ids = ['changed_check'];
    } else if (this.drift === 'authority') {
      for (const entry of snapshot.policy.rules.authorities) entry.identity.digest = hash('revoked ' + entry.type);
    } else if (this.drift === 'capability') snapshot.available_capabilities = [];
    snapshot.policy.digest = hash(snapshot.policy.rules);
    return snapshot;
  }
  private replay() {
    return checked(this.api.replayExecutionJournal(this.journal, this.authority));
  }
  private target(slot: number) {
    const claim = this.replay().claims.find((entry) => entry.id === `claim_${slot}`);
    return { claim: { id: `claim_${slot}`, version: claim?.version ?? slot + 1 }, attempt_id: `attempt_${slot}` };
  }
  private report(step: Extract<Step, { kind: 'receipt' }>): AttemptReceipt {
    const claim = this.replay().claims.find((entry) => entry.id === `claim_${step.slot}`);
    const receipt: AttemptReceipt['receipt'] = {
      schema_version: '0.1',
      id: `receipt_${step.identity}`,
      ...this.target(step.slot),
      executor: claim?.executor ?? executor('a'),
      request: this.api.requestReference(this.journal.execution.action_request),
      binding: structuredClone(this.journal.execution.action_request.request.binding),
      execution_policy: {
        id: this.journal.execution.execution_policy.id,
        digest: this.journal.execution.execution_policy.digest,
      },
      status: step.status,
      effect: step.effect,
      resulting_subject: null,
      finished_at: date(this.time + (step.fault === 'future' ? 1 : 0)),
      evidence: [{ id: 'synthetic_proof', digest: hash('synthetic_proof') }],
    };
    if (step.fault === 'binding') receipt.binding.state_version++;
    return { receipt, receipt_digest: step.fault === 'digest' ? hash('wrong') : hash(receipt) };
  }
  private admission(envelope: AttemptReceipt, fault: string): ReceiptAdmission[] {
    if (fault === 'admission') return [];
    const report = envelope.receipt;
    const admission: ReceiptAdmission['admission'] = {
      schema_version: '0.1',
      id: `admission_${report.id}_${hash([envelope.receipt_digest, this.time, fault === 'expired_admission'])}`,
      request: report.request,
      binding: report.binding,
      execution_policy: report.execution_policy,
      claim: report.claim,
      attempt_id: report.attempt_id,
      executor: report.executor,
      receipt: { id: report.id, digest: envelope.receipt_digest },
      verification_policy: this.base.policy.rules.evidence_policies[0]!,
      acceptance: { id: `accept_${report.id}`, digest: hash(envelope) },
      admitted_at: date(this.time),
      valid_until: fault === 'expired_admission' ? date(this.time) : null,
    };
    return [{ admission, admission_digest: hash(admission) }];
  }
  async apply(step: Step, index: number, restartFile: string) {
    if (step.kind === 'clock') {
      this.time += step.by;
      return;
    }
    if (step.kind === 'drift') {
      this.drift = step.field;
      return;
    }
    if (step.kind === 'restart') {
      const before = canonicalJson(this.replay());
      await writeFile(restartFile, canonicalJson({ journal: this.journal, admissions: [...this.admissions] }));
      const restored = JSON.parse(await readFile(restartFile, 'utf8')) as {
        journal: ExecutionJournal;
        admissions: string[];
      };
      this.journal = restored.journal;
      this.admissions = new Set(restored.admissions);
      assert.equal(canonicalJson(this.replay()), before, 'restart changed the journal projection');
      return;
    }
    if (step.kind === 'evaluate') {
      this.evaluate();
      return;
    }
    if (step.kind === 'human_request' || step.kind === 'terminal' || step.kind === 'executor_transition') {
      await this.boundary(step.kind);
      return;
    }
    let actor: ExecutionContext['actor'] = { kind: 'executor', executor: executor('a') };
    let command: ExecutionOperation['command'];
    let receiptFault = 'none';
    let recovery: RecoveryEvidence[] = [];
    if (step.kind === 'redeliver') {
      const saved = this.deliveries.get(step.index);
      if (!saved) return;
      const operation = structuredClone(saved.operation);
      if (step.changed) operation.execution_policy.digest = hash('changed operation');
      const context = { ...structuredClone(saved.context), snapshot: this.snapshot() };
      this.applyOperation(context, operation);
      return;
    }
    if (step.kind === 'acquire' || step.kind === 'replace') {
      actor = { kind: 'executor', executor: executor(step.actor) };
      const grant = {
        claim_id: `claim_${step.slot}`,
        attempt_id: `attempt_${step.slot}`,
        executor: executor(step.actor),
        valid_until: date(this.time + step.lease),
      };
      command =
        step.kind === 'acquire'
          ? { kind: 'acquire', ...grant }
          : {
              kind: 'replace',
              ...grant,
              previous_claim: this.replay().claims.at(-1)
                ? { id: this.replay().claims.at(-1)!.id, version: this.replay().claims.at(-1)!.version }
                : { id: 'missing', version: 1 },
              evidence_ids: [],
            };
    } else if (step.kind === 'start' || step.kind === 'release' || step.kind === 'renew') {
      actor = { kind: 'executor', executor: executor(step.actor) };
      command =
        step.kind === 'renew'
          ? { kind: 'renew', ...this.target(step.slot), valid_until: date(this.time + 20) }
          : { kind: step.kind, ...this.target(step.slot) };
    } else if (step.kind === 'reconcile') {
      const target = this.target(step.slot);
      const claim = this.replay().claims.find((entry) => entry.id === target.claim.id);
      const kinds: RecoveryEvidence['evidence']['kind'][] =
        step.proof === 'missing'
          ? []
          : step.proof === 'contradictory'
            ? ['executor_stopped', 'no_effect', 'effect_occurred']
            : [
                'executor_stopped',
                ...(step.disposition === 'no_effect_confirmed'
                  ? ['no_effect' as const]
                  : step.disposition === 'effect_confirmed'
                    ? ['effect_occurred' as const]
                    : []),
              ];
      recovery = kinds.map((kind) => {
        const evidence: RecoveryEvidence['evidence'] = {
          schema_version: '0.1',
          id: `recovery_${index}_${kind}`,
          ...target,
          executor: claim?.executor ?? executor('a'),
          request: this.api.requestReference(this.journal.execution.action_request),
          binding: this.journal.execution.action_request.request.binding,
          execution_policy: {
            id: this.journal.execution.execution_policy.id,
            digest: this.journal.execution.execution_policy.digest,
          },
          kind,
          observed_at: date(this.time),
          resulting_subject: null,
          verification_policy: this.base.policy.rules.evidence_policies[0]!,
          acceptance: { id: `recovery_acceptance_${index}_${kind}`, digest: hash([index, kind]) },
        };
        return { evidence, evidence_digest: hash(evidence) };
      });
      actor = step.actor === 'human' ? this.controlActor('human') : actor;
      command = {
        kind: 'reconcile',
        ...target,
        disposition: step.disposition,
        evidence_ids: recovery.length ? recovery.map((entry) => entry.evidence.id) : ['missing_recovery'],
        reason: 'Generated independent recovery evidence',
      };
    } else if (step.kind === 'expire') {
      actor = this.controlActor('threadloop');
      command = { kind: 'expire', ...this.target(step.slot) };
    } else if (step.kind === 'cancel') {
      actor =
        step.actor === 'executor' ? actor : this.controlActor(step.actor === 'controller' ? 'threadloop' : 'human');
      command = { kind: 'cancel', reason: 'Generated cancellation' };
    } else if (step.kind === 'invalidate') {
      actor = this.controlActor('threadloop');
      command = { kind: 'invalidate', reason: 'integrity_failure' };
    } else if (step.kind === 'receipt' || step.kind === 'receipt_replay') {
      let envelope: AttemptReceipt;
      if (step.kind === 'receipt') {
        envelope = this.report(step);
        receiptFault = step.fault;
        if (step.fault === 'malformed') {
          const malformed = { ...envelope, receipt: { ...envelope.receipt, schema_version: 'unknown' } };
          this.applyOperation(
            this.context(actor),
            this.operation(index, actor, { kind: 'submit_receipt', receipt: malformed as AttemptReceipt }),
          );
          return;
        }
      } else {
        const previous = this.reports.get(step.identity);
        if (!previous) return;
        envelope = structuredClone(previous);
        if (step.changed) {
          envelope.receipt.evidence[0]!.digest = hash('changed report');
          envelope.receipt_digest = hash(envelope.receipt);
        }
      }
      actor = { kind: 'executor', executor: envelope.receipt.executor };
      command = { kind: 'submit_receipt', receipt: envelope };
    } else {
      actor = this.controlActor('threadloop');
      const request = structuredClone(this.journal.execution.action_request);
      if (step.kind === 'register_conflict') {
        request.request.inputs.push({ role: 'release_manifest', artifact: { id: 'another', digest: hash('another') } });
        request.request_digest = hash(request.request);
      }
      command = { kind: 'register_request', request };
    }
    const context = this.context(actor);
    context.recovery_evidence = recovery;
    if (command.kind === 'submit_receipt') {
      context.receipt_admissions =
        step.kind === 'receipt_replay' && !step.changed
          ? structuredClone(this.reportAdmissions.get(step.identity) ?? [])
          : this.admission(command.receipt, receiptFault);
    }
    const operation = this.operation(index, actor, command);
    const applied = this.applyOperation(context, operation, step.kind !== 'untrusted');
    if (applied) {
      this.deliveries.set(index, structuredClone({ context, operation }));
      if (step.kind === 'receipt' && command.kind === 'submit_receipt' && !this.reports.has(step.identity)) {
        this.reports.set(step.identity, structuredClone(command.receipt));
        this.reportAdmissions.set(step.identity, structuredClone(context.receipt_admissions));
      }
    }
  }
  private controlActor(kind: 'threadloop' | 'human'): ExecutionContext['actor'] {
    return { kind, identity: this.base.policy.rules.authorities.find((entry) => entry.type === kind)!.identity };
  }
  private context(actor: ExecutionContext['actor']): ExecutionContext {
    return { actor, snapshot: this.snapshot(), receipt_admissions: [], recovery_evidence: [] };
  }
  private operation(
    index: number,
    actor: ExecutionContext['actor'],
    command: ExecutionOperation['command'],
  ): ExecutionOperation {
    return {
      schema_version: '0.1',
      id: `operation_${index}`,
      actor,
      command,
      expected_revision: this.journal.execution.entries.length,
      expected_execution_digest: this.journal.execution_digest,
      request: this.api.requestReference(this.journal.execution.action_request),
      binding: this.journal.execution.action_request.request.binding,
      execution_policy: {
        id: this.journal.execution.execution_policy.id,
        digest: this.journal.execution.execution_policy.digest,
      },
    };
  }
  private applyOperation(context: ExecutionContext, operation: ExecutionOperation, trusted = true) {
    const digest = this.api.executionAdmissionDigest({
      kind: 'operation',
      execution_digest: this.journal.execution_digest,
      context,
      operation,
    });
    if (trusted) this.admissions.add(digest);
    this.attempted.push(structuredClone({ context, operation }));
    const result = this.api.applyExecutionOperation(this.journal, context, operation, this.authority);
    if (result.ok) {
      this.journal = result.value.journal;
      return true;
    }
    assert.ok(
      result.diagnostics.every((entry) => entry.recovery.length > 0),
      'rejection needs recovery guidance',
    );
    return false;
  }
  private evaluate() {
    const snapshot = this.snapshot();
    this.admissions.add(
      this.api.executionAdmissionDigest({
        kind: 'projection',
        execution_digest: this.journal.execution_digest,
        snapshot,
      }),
    );
    const projected = this.api.projectControllerExecution(this.journal, snapshot, this.authority);
    if (!projected.ok) return;
    Object.assign(snapshot, projected.value);
    for (const edge of snapshot.compiled_graph.graph.transitions.filter(
      (edge) => edge.from === snapshot.binding.source_state,
    )) {
      const decision = {
        schema_version: '0.1',
        binding: snapshot.binding,
        input_digest: hash(snapshot),
        outcome: 'transition_available',
        transition_id: edge.id,
        target_state: edge.to,
        checks: edge.guard_refs.map((guard_id) => ({ guard_id, evidence_ids: [] })),
      };
      assert.equal(
        this.controllerApi.validateControllerDecision(snapshot, { decision, decision_digest: hash(decision) }).ok,
        false,
        'execution receipts cannot supply missing lifecycle guard evidence',
      );
    }
  }
  private async boundary(kind: 'human_request' | 'terminal' | 'executor_transition') {
    const snapshot = await publicSnapshot(
      kind === 'human_request' ? 'human_merge' : kind === 'terminal' ? 'terminal' : 'action_required',
    );
    if (kind === 'terminal') {
      const terminal = {
        schema_version: '0.1',
        binding: snapshot.binding,
        input_digest: hash(snapshot),
        outcome: 'terminal',
        terminal_state: snapshot.binding.source_state,
      };
      assert.equal(
        this.controllerApi.validateControllerDecision(snapshot, { decision: terminal, decision_digest: hash(terminal) })
          .ok,
        true,
      );
      assert.equal(
        buildActionRequest(snapshot, {
          action_id: 'run_gates',
          transition_id: 'human_handoff',
          guard_ids: ['review_set'],
          inputs: [],
          evidence_ids: [],
          evidence_requirements: [],
          valid_until: null,
        }).ok,
        false,
      );
    }
    if (kind === 'executor_transition' || kind === 'terminal') {
      const decision = {
        schema_version: '0.1',
        binding: snapshot.binding,
        input_digest: hash(snapshot),
        outcome: 'transition_available',
        transition_id: 'complete',
        target_state: 'completed',
        checks: [],
      };
      assert.equal(
        this.controllerApi.validateControllerDecision(snapshot, { decision, decision_digest: hash(decision) }).ok,
        false,
        'an executor cannot select an unsupported lifecycle transition',
      );
    } else {
      const asset = new URL(
        import.meta.resolve('threadloop-contracts/assets/controller-v0.1/fixtures/valid/human_merge.request.canonical'),
      );
      const body = JSON.parse(await readFile(asset, 'utf8')) as ActionRequest['request'];
      const request: ActionRequest = { request: body, request_digest: hash(body) };
      const context = { ...this.context(this.controlActor('threadloop')), snapshot };
      const rules = {
        request: this.api.requestReference(request),
        workflow_policy: request.request.policy,
        retry_safety: 'reconciliation_required' as const,
        max_attempts: 1,
      };
      const policy = { id: 'human_policy', digest: hash(rules), rules };
      const admission = this.api.executionAdmissionDigest({ kind: 'create', context, request, policy });
      const authority = { isAdmitted: (candidate: string) => candidate === admission };
      assert.equal(
        this.api.createExecutionJournal(context, request, policy, authority).ok,
        false,
        'a human action cannot become executor work',
      );
    }
  }
  observe(): Observation {
    const projected = this.replay();
    for (const report of projected.receipts) {
      const original = this.reports.get(numberOf(report.envelope.receipt.id));
      if (original) assert.deepEqual(report.envelope, original, 'receipt identity must retain its first content');
    }
    assert.equal(
      this.journal.execution.entries.length,
      projected.revision,
      'audit entry count differs from authoritative revision',
    );
    const snapshot = this.snapshot();
    this.admissions.add(
      this.api.executionAdmissionDigest({
        kind: 'projection',
        execution_digest: this.journal.execution_digest,
        snapshot,
      }),
    );
    const controller = this.api.projectControllerExecution(this.journal, snapshot, this.authority);
    assert.equal(snapshot.binding.source_state, this.base.binding.source_state, 'execution changed lifecycle state');
    return {
      revision: projected.revision,
      request: projected.request_status,
      claims: projected.claims.map((claim) => ({
        slot: numberOf(claim.id),
        version: claim.version,
        status: claim.status,
        deadline: seconds(claim.valid_until),
      })),
      attempts: projected.attempts.map((attempt) => ({
        slot: numberOf(attempt.id),
        status: attempt.status,
        effect: attempt.effect,
        receipt: attempt.receipt_id === null ? null : numberOf(attempt.receipt_id),
        resolution: attempt.resolution?.disposition ?? null,
      })),
      receipts: projected.receipts.map((report) => ({
        identity: numberOf(report.envelope.receipt.id),
        accepted: report.result.code === 'RECEIPT_ACCEPTED',
      })),
      conflicts: projected.conflicts.map((conflict) => ({
        namespace: conflict.namespace,
        identity: conflict.namespace === 'request' ? 'request' : conflict.identity,
      })),
      execution: controller.ok ? controller.value.execution.status : 'invalid',
    };
  }
  conformanceInput() {
    return {
      initial: {
        context: this.journal.execution.initial_context,
        request: this.journal.execution.action_request,
        policy: this.journal.execution.execution_policy,
      },
      steps: this.attempted,
      admitted_digests: [...this.admissions],
      projection_snapshot: this.snapshot(),
    };
  }
}
