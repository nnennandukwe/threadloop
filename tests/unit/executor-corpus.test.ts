import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { canonicalExecutorJson, parseExecutorMessage } from '../../scripts/executor-contract/codec.js';
import {
  publishedExecutorSchemas,
  type ExecutorRequest,
  type GaapMappingPolicy,
} from '../../scripts/executor-contract/contracts.js';
import { buildGaapRequest, mapGaapResult } from '../../scripts/executor-contract/gaap.js';
import { gaapDigest, validateGaapReceipt } from '../../scripts/executor-contract/gaap-validation.js';
import { validateExecutorContext } from '../../scripts/executor-contract/validation.js';
import { executorFixture, executorFixtureAuthority } from '../fixtures/executor-contract.js';
import {
  applyExecutionOperation,
  operate,
  operationFor,
  projectControllerExecution,
  receiptAdmissionFor,
  submitReceipt,
} from '../fixtures/execution-contract.js';
import type { ExecutionJournal } from '../../scripts/execution-contract/contracts.js';
import type { ControllerInput } from '../../scripts/controller-contract/contracts.js';
import type { GaapReceipt } from '../../scripts/executor-contract/gaap-types.js';
import { ajv, codes, publishedValidators } from '../fixtures/contracts.js';

const root = new URL('../../docs/contracts/executor-v0.1/', import.meta.url);
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, root), 'utf8')) as unknown;
}
async function input(filename = 'local-gates.json') {
  return (await json(`fixtures/${filename}`)) as {
    request: ExecutorRequest;
    mapping: GaapMappingPolicy;
    journal: ExecutionJournal;
    snapshot: ControllerInput;
  };
}

const outcomes = [
  'completed',
  'blocked',
  'denied-effect',
  'failed',
  'interrupted',
  'budget-exhausted',
  'stale-verification',
];

const validators = Object.fromEntries(
  Object.entries(publishedExecutorSchemas()).map(([name, schema]) => [name, ajv().compile(schema)]),
);

describe('Published executor corpus', () => {
  it('matches independently authored request bytes and digests', async () => {
    const fixture = await input();
    const mapped = buildGaapRequest(fixture.request, fixture.mapping);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.value).toEqual(await json('fixtures/gaap-request.json'));
    const expected = await readFile(new URL('fixtures/gaap-request.canonical', root), 'utf8');
    expect(canonicalExecutorJson(mapped.value)).toEqual({ ok: true, value: expected });
    const golden = (await json('fixtures/golden-digests.json')) as {
      executor_request: string;
      gaap_request: string;
      gaap_run_id: string;
    };
    expect(gaapDigest(mapped.value)).toEqual({ ok: true, value: golden.gaap_request });
    expect(fixture.request.request_digest).toBe(golden.executor_request);
    expect(mapped.value.run_id).toBe(golden.gaap_run_id);
    expect(canonicalExecutorJson(fixture.request)).toEqual({
      ok: true,
      value: await readFile(new URL('fixtures/executor-request.canonical', root), 'utf8'),
    });
    expect(canonicalJson(mapped.value)).toBe(expected);
  });
  it('preserves RFC 8785 UTF-16 key order independently of JavaScript object enumeration', () => {
    // Protocol test data: Unicode is required by RFC 8785 and exempt from ASCII source-string rules.
    const source =
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin","€":"Euro","😀":"Emoji","דּ":"Hebrew"}';
    const parsed = parseExecutorMessage(Buffer.from(source));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(canonicalExecutorJson(parsed.value)).toEqual({ ok: true, value: source });
    expect(canonicalJson(parsed.value)).not.toBe(source);
  });
  it.each(outcomes)(
    'maps published %s bytes into schema-valid results without creating trusted admission',
    async (name) => {
      const fixture = await input();
      expect((await executorFixture()).started.journal).toEqual(fixture.journal);
      const scenario = (await json(`fixtures/${name}.json`)) as {
        receipt_file: string;
        observation: unknown;
        expected: { status: string; reason: string; effect: string };
      };
      const bytes = await readFile(new URL(`fixtures/${scenario.receipt_file}`, root));
      const result = mapGaapResult(fixture.request, fixture.mapping, bytes, scenario.observation);
      if (!result.ok) throw new Error(JSON.stringify(result));
      for (const [schema, example] of [
        ['executor-result', result.value],
        ['result-observation', scenario.observation],
      ] as const) {
        expect(validators[schema]!(example), JSON.stringify(validators[schema]!.errors)).toBe(true);
        expect(validators[schema]!({ ...(example as object), unrecognized_field: true })).toBe(false);
      }
      const report = result.value.result.attempt_receipt;
      expect(report.receipt.status).toBe(scenario.expected.status);
      expect(report.receipt.effect).toBe(scenario.expected.effect);
      expect(result.value.result.reason.code).toBe(scenario.expected.reason);
      const rejected = submitReceipt(fixture.journal, report, undefined, []);
      expect(rejected.result.code).toBe('RECEIPT_ADMISSION_MISMATCH');
      expect(rejected.projection.attempts.at(-1)?.status).toBe('running');
      const projected = projectControllerExecution(rejected.journal, {
        ...fixture.snapshot,
        evaluation_time: '2026-09-10T10:01:00.000Z',
      });
      expect(projected.ok && projected.value.execution.status).toBe('in_flight');
      // Deliberately synthetic trusted admission, independent from the mapper. No artifacts are authenticated here.
      const admitted = submitReceipt(fixture.journal, report);
      expect(admitted.result.disposition).toBe('applied');
      expect(admitted.projection.attempts.at(-1)?.status).toBe(name === 'completed' ? 'succeeded' : 'unknown_outcome');
      const late = submitReceipt(fixture.journal, report, '2026-09-10T10:05:00.000Z');
      expect(late.result.code).toBe('CLAIM_FENCED');
      expect(late.projection.attempts.at(-1)?.status).not.toBe('succeeded');
      const snapshot = structuredClone(fixture.snapshot);
      snapshot.binding.subject.content_digest = 'f'.repeat(64);
      const authority = executorFixtureAuthority(fixture.journal, snapshot, fixture.request);
      expect(codes(validateExecutorContext(fixture.request, fixture.journal, snapshot, authority))).toEqual([
        'EXECUTOR_CONTEXT_MISMATCH',
      ]);
    },
  );
  it('matches every generated schema and validates the published request and mapping offline', async () => {
    await publishedValidators('executor', publishedExecutorSchemas());
    const fixture = await input();
    for (const [schema, example] of [
      ['executor-request', fixture.request],
      ['gaap-mapping-policy', fixture.mapping],
    ] as const) {
      expect(validators[schema]!(example), JSON.stringify(validators[schema]!.errors)).toBe(true);
      expect(validators[schema]!({ ...example, unrecognized_field: true })).toBe(false);
    }
  });
  it.each(['expired-claim', 'stale-subject'])(
    'rejects the published %s context and completed receipt',
    async (name) => {
      const scenario = (await json(`fixtures/${name}.json`)) as {
        input_file: string;
        receipt_file: string;
        evaluation_time?: string;
        current_subject_digest?: string;
        expected_preflight: string;
        expected_receipt_disposition?: string;
      };
      expect(typeof scenario.input_file).toBe('string');
      const fixture = await input(scenario.input_file);
      const admittedHistory = await executorFixture();
      expect(fixture.journal).toEqual(admittedHistory.started.journal);
      const completed = (await json('fixtures/completed.json')) as { receipt_file: string; observation: unknown };
      expect(scenario.receipt_file).toBe(completed.receipt_file);
      const mapped = mapGaapResult(
        fixture.request,
        fixture.mapping,
        await readFile(new URL(`fixtures/${scenario.receipt_file}`, root)),
        completed.observation,
      );
      expect(mapped.ok, JSON.stringify(mapped)).toBe(true);
      if (!mapped.ok) return;
      const receipt = mapped.value.result.attempt_receipt;
      expect(receipt.receipt.status).toBe('succeeded');
      // Synthetic admission proves this same report is otherwise admissible. No producer is authenticated here.
      const fresh = operate(
        fixture.journal,
        { kind: 'submit_receipt', receipt },
        undefined,
        receipt.receipt.finished_at,
      );
      expect(fresh.result).toMatchObject({ disposition: 'applied', code: 'RECEIPT_ACCEPTED' });
      fixture.snapshot.evaluation_time = scenario.evaluation_time ?? receipt.receipt.finished_at;
      if (scenario.current_subject_digest)
        fixture.snapshot.binding.subject.content_digest = scenario.current_subject_digest;
      const authority = executorFixtureAuthority(fixture.journal, fixture.snapshot, fixture.request);
      expect(validateExecutorContext(fixture.request, fixture.journal, fixture.snapshot, authority)).toMatchObject({
        ok: false,
        diagnostics: [{ code: scenario.expected_preflight }],
      });
      const context = structuredClone(fixture.journal.execution.initial_context);
      context.actor = { kind: 'executor', executor: receipt.receipt.executor };
      context.snapshot = fixture.snapshot;
      context.receipt_admissions = [receiptAdmissionFor(fixture.journal, receipt)];
      const submitted = applyExecutionOperation(
        fixture.journal,
        context,
        operationFor(fixture.journal, context.actor, { kind: 'submit_receipt', receipt }),
      );
      expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
      if (!submitted.ok) return;
      expect(submitted.value.result).toMatchObject({
        disposition: 'rejected',
        code: name === 'expired-claim' ? 'CLAIM_FENCED' : 'REQUEST_NOT_CURRENT',
      });
      if (name === 'expired-claim')
        expect(submitted.value.result.disposition).toBe(scenario.expected_receipt_disposition);
      expect(submitted.value.projection.request_status).toBe('open');
      expect(submitted.value.projection.attempts.at(-1)?.status).toBe('running');
      expect(submitted.value.projection.receipts.at(-1)?.envelope).toEqual(receipt);
      const projected = projectControllerExecution(submitted.value.journal, fixture.snapshot);
      expect(projected.ok, JSON.stringify(projected)).toBe(true);
      if (!projected.ok) return;
      expect(projected.value.execution.status).toBe('reconciliation_required');
    },
  );
  it('retains duplicate acceptance and detects changed content under the same receipt identity', async () => {
    const fixture = await executorFixture();
    const scenario = (await json('fixtures/completed.json')) as { observation: unknown };
    const mapped = mapGaapResult(
      fixture.envelope,
      fixture.mapping,
      await readFile(new URL('fixtures/completed.gaap.canonical', root)),
      scenario.observation,
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const receipt = mapped.value.result.attempt_receipt;
    const accepted = operate(
      fixture.started.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T10:01:00.000Z',
    );
    const repeated = operate(
      accepted.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T10:02:00.000Z',
    );
    expect(repeated.result).toEqual(accepted.result);
    expect(repeated.projection.receipts).toHaveLength(1);
    receipt.receipt.finished_at = '2026-09-10T10:01:01.000Z';
    receipt.receipt_digest = sha256(canonicalJson(receipt.receipt));
    const conflict = operate(
      repeated.journal,
      { kind: 'submit_receipt', receipt },
      undefined,
      '2026-09-10T10:02:00.000Z',
    );
    expect(conflict.result.code).toBe('IDENTITY_CONFLICT');
    expect(conflict.projection.receipts).toHaveLength(1);
  });
  it('retains exact upstream provenance and verifies every native example', async () => {
    const provenance = (await json('upstream/gaap/provenance.json')) as {
      commit: string;
      files: { path: string; sha256: string }[];
    };
    expect(provenance.commit).toBe('712875cbf4be6dd02093f50f93ae826f20cb4890');
    const request = await json('upstream/gaap/agent-run-request.json');
    for (const file of provenance.files) {
      const bytes = await readFile(new URL(`upstream/gaap/${file.path}`, root));
      expect(sha256(bytes)).toBe(file.sha256);
      if (!file.path.includes('schema') && file.path !== 'agent-run-request.json') {
        const result = validateGaapReceipt(JSON.parse(bytes.toString()) as unknown, request);
        expect(result.ok, file.path + JSON.stringify(result)).toBe(true);
      }
    }
  });
  it.each([
    ['ask_effect', 'earlier matching allow decision'],
    ['wrong_completion_subject', 'bind the current subject'],
    ['stale_verifier', 'Completion requires'],
    ['same_actor', 'different actor'],
    ['missing_evidence', 'every requested evidence type'],
    ['missing_interruption', 'Interrupted receipts require interruption evidence'],
    ['nonterminal', 'must contain a terminal receipt'],
    ['changed_usage', 'final usage must agree'],
  ])('rejects resealed semantic failure %s', async (mutation, reason) => {
    const request = await json('upstream/gaap/agent-run-request.json');
    const receipt = (await json(
      `upstream/gaap/${mutation === 'missing_interruption' ? 'interrupted' : 'completed'}.json`,
    )) as GaapReceipt;
    const body = receipt.body;
    for (const event of body.events) {
      if (mutation === 'ask_effect' && event.event_type === 'protected_effect_decision' && event.gate === 'permission')
        event.decision.outcome = 'ask';
      if (
        mutation === 'wrong_completion_subject' &&
        event.event_type === 'protected_effect_decision' &&
        event.decision.code === 'workflow.completion_authorized'
      )
        event.subject_digest = 'sha256:' + '0'.repeat(64);
      if (event.event_type === 'verification') {
        if (mutation === 'stale_verifier') event.subject_digest = body.initial_subject_digest;
        if (mutation === 'same_actor') event.verifier_id = event.implementer_id;
        if (mutation === 'missing_evidence')
          event.evidence = event.evidence.filter((entry) => entry.evidence_type !== 'command_output');
      }
    }
    if (mutation === 'missing_interruption')
      body.events = body.events
        .filter((event) => event.event_type !== 'interruption')
        .map((event, index) => ({ ...event, sequence: index + 1 }));
    if (mutation === 'nonterminal') body.terminal_status = 'awaiting_authority';
    if (mutation === 'changed_usage') body.usage.model_tokens++;
    const digest = gaapDigest(body);
    if (!digest.ok) throw new Error('Invalid test fixture');
    receipt.receipt_digest = digest.value;
    const result = validateGaapReceipt(receipt, request);
    expect(result.ok || result.diagnostics[0]!.message).toContain(reason);
  });
});
