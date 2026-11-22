import { expect, it, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { ScenarioJournal } from '../../scripts/controller-conformance/scenario-journal.js';
import { readSealedRoot, writeSealedRoot } from '../../src/adapters/fs/sealed-root.js';
import { cleanupTemporaryState, makeTempDir } from '../helpers/session.js';

import {
  createExecutionJournal,
  applyExecutionOperation,
  executionAdmissionDigest,
  requestReference,
} from 'threadloop-contracts/execution';
import type {
  ExecutionContext,
  ExecutionOperation,
  ExecutionPolicy,
  ExecutionJournal,
} from 'threadloop-contracts/execution';
import { publicSnapshot } from '../generated/controller/adapter.js';
import { selectWorkflowDecision } from '../../src/domain/workflow-controller.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { runExecutionScenario } from '../../scripts/controller-conformance/execution-scenario.js';

afterEach(cleanupTemporaryState);

async function fixture() {
  const snapshot = await publicSnapshot();
  const selected = selectWorkflowDecision(snapshot);
  if (!selected.ok || selected.value.decision.outcome !== 'engineering_action_required')
    throw new Error('Fixture requires an engineering action.');
  const request = selected.value.decision.action_request;
  const rules: ExecutionPolicy['rules'] = {
    request: requestReference(request),
    workflow_policy: { id: snapshot.policy.id, digest: snapshot.policy.digest },
    retry_safety: 'reconciliation_required',
    max_attempts: 2,
  };
  const policy = { id: 'scenario_policy', rules, digest: sha256(canonicalJson(rules)) };
  const identity = snapshot.policy.rules.authorities.find((item) => item.type === 'threadloop')!.identity;
  const context: ExecutionContext = {
    snapshot,
    actor: { kind: 'threadloop', identity },
    recovery_evidence: [],
    receipt_admissions: [],
  };
  const initial = { context, request, policy };
  const admissions = new Set([executionAdmissionDigest({ kind: 'create', ...initial })]);
  const authority = { isAdmitted: (digest: string) => admissions.has(digest) };
  const created = createExecutionJournal(context, request, policy, authority);
  if (!created.ok) throw new Error(JSON.stringify(created.diagnostics));
  const genesis = created.value;
  const operation: ExecutionOperation = {
    schema_version: '0.1',
    id: 'register_once',
    actor: context.actor,
    request: rules.request,
    binding: request.request.binding,
    execution_policy: { id: policy.id, digest: policy.digest },
    expected_revision: 0,
    expected_execution_digest: genesis.execution_digest,
    command: { kind: 'register_request', request },
  };
  const register = { context, operation };
  function authorizeStep(journal: ExecutionJournal, step: typeof register) {
    admissions.add(
      executionAdmissionDigest({ kind: 'operation', execution_digest: journal.execution_digest, ...step }),
    );
  }
  authorizeStep(genesis, register);
  const registered = applyExecutionOperation(genesis, context, operation, authority);
  if (!registered.ok) throw new Error(JSON.stringify(registered.diagnostics));
  return {
    initial,
    register,
    genesis,
    registered: registered.value.journal,
    admissions,
    authority,
    authorizeStep,
    snapshot,
  };
}

it('requires an admission at the retained prefix before returning a registered operation on replay', async () => {
  const { initial, register, registered, admissions, authorizeStep, snapshot } = await fixture();
  const run = () =>
    runExecutionScenario({
      initial,
      steps: [register, register],
      projection_snapshot: snapshot,
      admitted_digests: [...admissions],
    });
  expect(run()).toEqual({
    status: 'invalid',
    diagnostics: [{ code: 'UNTRUSTED_EXECUTION_INPUT', path: '$', identifier: null }],
  });
  authorizeStep(registered, register);
  admissions.add(
    executionAdmissionDigest({ kind: 'projection', execution_digest: registered.execution_digest, snapshot }),
  );
  const result = {
    disposition: 'applied',
    code: 'REQUEST_ALREADY_REGISTERED',
    revision: 1,
    claim: null,
    attempt_id: null,
  };
  expect(run()).toMatchObject({
    status: 'execution',
    steps: [
      { ...result, replayed: false },
      { ...result, replayed: true },
    ],
    projection: { revision: 1, request_status: 'open', claims: [], attempts: [], receipts: [], conflicts: [] },
  });
});

type Step = { context: ExecutionContext; operation: ExecutionOperation };

async function storedFixture() {
  const facts = await fixture();
  const filename = path.join(await makeTempDir(), 'case.sqlite');
  const store = new ScenarioJournal(filename, facts.authority);
  store.initialize(facts.genesis);
  return { ...facts, filename, store };
}

function readRow(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return readSealedRoot(db);
  } finally {
    db.close();
  }
}

function writer(filename: string, step: Step, admissions: Set<string>, cut?: string) {
  const args = ['--import', 'tsx'];
  if (cut) args.push('--import', fileURLToPath(new URL('../fixtures/workflow/sqlite-cut.mjs', import.meta.url)));
  args.push(fileURLToPath(new URL('../fixtures/controller-execution-writer.mjs', import.meta.url)));
  const child = execFile(process.execPath, args, {
    timeout: 15_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...(cut ? { THREADLOOP_TEST_SQLITE_CUT: cut } : {}) },
  });
  const stderr: string[] = [];
  const stdout: string[] = [];
  child.stdout!.on('data', (data: string) => stdout.push(data));
  const atLock = new Promise<void>((resolve, reject) => {
    child.stderr!.on('data', (data: string) => {
      stderr.push(data);
      if (stderr.join('').includes('scenario-writer-at-begin')) resolve();
    });
    child.on('error', reject);
    child.once('close', () => reject(new Error('Writer exited before reaching BEGIN IMMEDIATE: ' + stderr.join(''))));
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) =>
        resolve({ code, signal, stdout: stdout.join(''), stderr: stderr.join('') }),
      );
    },
  );
  child.stdin!.end(JSON.stringify({ filename, step, admissions: [...admissions] }));
  return { atLock, exit };
}

it('preserves the committed row on stale storage CAS and refuses an inner journal whose outer seal is valid', async () => {
  const { filename, store, genesis, register, registered, snapshot } = await storedFixture();
  const initial = readRow(filename);
  expect(store.apply(register.context, register.operation)).toMatchObject({ ok: true, value: { replayed: false } });
  const committed = readRow(filename);
  expect(committed.value).toEqual(registered);
  const stale = new DatabaseSync(filename);
  try {
    expect(() => writeSealedRoot(stale, genesis, initial.digest)).toThrow(/retained executor root changed/i);
    expect(readRow(filename)).toEqual(committed);
    const damaged = { ...registered, execution_digest: '0'.repeat(64) };
    const body = canonicalJson(damaged);
    stale.prepare('UPDATE root SET body=?,digest=? WHERE id=1').run(body, sha256(body));
    expect(readRow(filename).value).toEqual(damaged);
    expect(store.project(snapshot)).toMatchObject({ ok: false, diagnostics: [{ code: 'EXECUTION_DIGEST_MISMATCH' }] });
    expect(store.apply(register.context, register.operation)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'EXECUTION_DIGEST_MISMATCH' }],
    });
    expect(readRow(filename).value).toEqual(damaged);
  } finally {
    stale.close();
  }
});

it.each(['before commit', 'after commit'] as const)(
  'recovers an interrupted registration %s using the retained prefix',
  async (cut) => {
    const { filename, store, register, admissions, registered, authorizeStep } = await storedFixture();
    const prior = readRow(filename);
    const process = writer(filename, register, admissions, cut);
    await process.atLock;
    const killed = await process.exit;
    expect(killed).toMatchObject({ signal: 'SIGKILL', stdout: '' });
    expect(killed.stderr).toContain('workflow-cut=' + cut);
    if (cut === 'before commit') {
      expect(readRow(filename)).toEqual(prior);
      expect(store.apply(register.context, register.operation)).toMatchObject({
        ok: true,
        value: { replayed: false, result: { revision: 1 } },
      });
    }
    const committed = readRow(filename);
    expect(committed.value).toEqual(registered);
    expect(store.apply(register.context, register.operation)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'UNTRUSTED_EXECUTION_INPUT' }],
    });
    authorizeStep(registered, register);
    expect(store.apply(register.context, register.operation)).toMatchObject({
      ok: true,
      value: { replayed: true, result: { revision: 1 } },
    });
    expect(readRow(filename)).toEqual(committed);
  },
);

it('records one grant and one admitted version conflict from two processes competing for the same journal revision', async () => {
  const { filename, store, register, initial, genesis, snapshot, admissions, authority, authorizeStep } =
    await storedFixture();
  if (!snapshot.evaluation_time) throw new Error('The test snapshot requires a fixed host clock.');
  const validUntil = new Date(Date.parse(snapshot.evaluation_time) + 30_000).toISOString();
  const contender = (name: string): Step => {
    const executor = { id: 'worker_' + name, incarnation: 'process_' + name };
    const actor: ExecutionContext['actor'] = { kind: 'executor', executor };
    return {
      context: { ...initial.context, actor },
      operation: {
        ...register.operation,
        id: 'acquire_' + name,
        actor,
        command: {
          kind: 'acquire',
          executor,
          claim_id: 'claim_' + name,
          attempt_id: 'attempt_' + name,
          valid_until: validUntil,
        },
      },
    };
  };
  const steps = [contender('left'), contender('right')] as const;
  // Admit both actual arrival orders. Each proposal still carries revision zero.
  for (const [first, second] of [
    [steps[0], steps[1]],
    [steps[1], steps[0]],
  ] as const) {
    authorizeStep(genesis, first);
    const proposal = applyExecutionOperation(genesis, first.context, first.operation, authority);
    if (!proposal.ok) throw new Error(JSON.stringify(proposal.diagnostics));
    authorizeStep(proposal.value.journal, second);
  }
  const owner = new DatabaseSync(filename);
  const start: ReturnType<typeof writer>[] = [];
  try {
    owner.exec('BEGIN IMMEDIATE');
    for (const step of steps) start.push(writer(filename, step, admissions));
    await Promise.all(start.map((proc) => proc.atLock));
    expect(readRow(filename).value).toEqual(genesis);
    owner.exec('COMMIT');
  } finally {
    owner.close();
  }
  const exits = await Promise.all(start.map((proc) => proc.exit));
  const reports = exits
    .map((result) => {
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as {
        result: { code: string; revision: number; disposition: string; claim: { id: string } | null };
      };
    })
    .sort((a, b) => a.result.revision - b.result.revision);
  expect(reports).toMatchObject([
    { replayed: false, result: { revision: 1, code: 'CLAIM_ACQUIRED', disposition: 'applied' } },
    {
      replayed: false,
      result: { revision: 2, code: 'EXECUTION_VERSION_CONFLICT', disposition: 'rejected', claim: null },
    },
  ]);
  const row = readRow(filename);
  const final = row.value as ExecutionJournal;
  expect(final.execution.entries).toHaveLength(2);
  admissions.add(executionAdmissionDigest({ kind: 'projection', execution_digest: final.execution_digest, snapshot }));
  expect(store.project(snapshot)).toMatchObject({
    ok: true,
    value: {
      projection: { revision: 2, claims: [{ id: reports[0]!.result.claim!.id }], attempts: [{ status: 'pending' }] },
    },
  });
  for (const step of steps) {
    authorizeStep(final, step);
    expect(store.apply(step.context, step.operation)).toMatchObject({ ok: true, value: { replayed: true } });
  }
  expect(readRow(filename)).toEqual(row);
});

it('refuses a different final snapshot without an independent admission and rejects duplicate authority digests', async () => {
  const { initial, register, registered, admissions, snapshot } = await fixture();
  admissions.add(
    executionAdmissionDigest({ kind: 'projection', execution_digest: registered.execution_digest, snapshot }),
  );
  const input = {
    initial,
    steps: [register],
    projection_snapshot: { ...snapshot, evaluation_time: '2026-09-10T10:00:01.000Z' },
    admitted_digests: [...admissions],
  };
  expect(runExecutionScenario(input)).toMatchObject({
    status: 'invalid',
    diagnostics: [{ code: 'UNTRUSTED_EXECUTION_INPUT' }],
  });
  expect(runExecutionScenario({ ...input, admitted_digests: [...admissions, ...admissions] })).toEqual({
    status: 'invalid',
    diagnostics: [{ code: 'DUPLICATE_ADMISSION', path: '$', identifier: null }],
  });
  expect(runExecutionScenario({ ...input, steps: Array(257).fill(register) })).toEqual({
    status: 'invalid',
    diagnostics: [{ code: 'SCHEMA_INVALID', path: '$.steps', identifier: null }],
  });
});
