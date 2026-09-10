import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
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
import { operate, projectControllerExecution } from '../fixtures/execution-contract.js';
import type { ExecutionJournal } from '../../scripts/execution-contract/contracts.js';
import type { ControllerInput } from '../../scripts/controller-contract/contracts.js';
import type { GaapReceipt } from '../../scripts/executor-contract/gaap-types.js';

const root = new URL('../../docs/contracts/executor-v0.1/', import.meta.url);
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, root), 'utf8')) as unknown;
}
async function input() {
  return (await json('fixtures/local-gates.json')) as {
    request: ExecutorRequest;
    mapping: GaapMappingPolicy;
    journal: ExecutionJournal;
    snapshot: ControllerInput;
  };
}

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
  it.each(['completed', 'blocked', 'denied-effect', 'failed', 'interrupted', 'budget-exhausted', 'stale-verification'])(
    'maps published %s bytes without creating trusted admission',
    async (name) => {
      const fixture = await input();
      const admittedHistory = await executorFixture();
      expect(admittedHistory.started.journal).toEqual(fixture.journal);
      const scenario = (await json(`fixtures/${name}.json`)) as {
        receipt_file: string;
        observation: unknown;
        expected: { status: string; reason: string; effect: string };
      };
      const result = mapGaapResult(
        fixture.request,
        fixture.mapping,
        await readFile(new URL(`fixtures/${scenario.receipt_file}`, root)),
        scenario.observation,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      const report = result.value.result.attempt_receipt;
      expect(report.receipt.status).toBe(scenario.expected.status);
      expect(report.receipt.effect).toBe(scenario.expected.effect);
      expect(result.value.result.reason.code).toBe(scenario.expected.reason);
      const rejected = operate(
        fixture.journal,
        { kind: 'submit_receipt', receipt: report },
        undefined,
        '2026-09-10T10:01:00.000Z',
        [],
        [],
      );
      expect(rejected.result.code).toBe('RECEIPT_ADMISSION_MISMATCH');
      expect(rejected.projection.attempts.at(-1)?.status).toBe('running');
      const projected = projectControllerExecution(rejected.journal, {
        ...fixture.snapshot,
        evaluation_time: '2026-09-10T10:01:00.000Z',
      });
      expect(projected.ok && projected.value.execution.status).toBe('in_flight');
      // Deliberately synthetic trusted admission, independent from the mapper. No artifacts are authenticated here.
      const admitted = operate(
        fixture.journal,
        { kind: 'submit_receipt', receipt: report },
        undefined,
        '2026-09-10T10:01:00.000Z',
      );
      expect(admitted.result.disposition).toBe('applied');
      expect(admitted.projection.attempts.at(-1)?.status).toBe(name === 'completed' ? 'succeeded' : 'unknown_outcome');
      const late = operate(
        fixture.journal,
        { kind: 'submit_receipt', receipt: report },
        undefined,
        '2026-09-10T10:05:00.000Z',
      );
      expect(late.result.disposition).toBe('rejected');
      expect(late.projection.attempts.at(-1)?.status).not.toBe('succeeded');
      const snapshot = structuredClone(fixture.snapshot);
      snapshot.binding.subject.content_digest = 'f'.repeat(64);
      const authority = executorFixtureAuthority(fixture.journal, snapshot, fixture.request);
      expect(validateExecutorContext(fixture.request, fixture.journal, snapshot, authority).ok).toBe(false);
    },
  );
  it('matches every generated schema and validates published examples offline', async () => {
    const schemas = publishedExecutorSchemas();
    const ajv = new Ajv2020({ strict: true, validateFormats: false });
    const fixture = await input();
    for (const [name, schema] of Object.entries(schemas)) {
      expect(await json(`schemas/${name}.schema.json`)).toEqual(schema);
      const validate = ajv.compile(schema);
      if (name === 'executor-request') expect(validate(fixture.request)).toBe(true);
      if (name === 'gaap-mapping-policy') expect(validate(fixture.mapping)).toBe(true);
    }
  });
  it.each(['expired-claim', 'stale-subject'])('rejects the published %s context', async (name) => {
    const fixture = await input();
    const scenario = (await json(`fixtures/${name}.json`)) as {
      evaluation_time?: string;
      current_subject_digest?: string;
      expected_preflight: string;
    };
    if (scenario.evaluation_time) fixture.snapshot.evaluation_time = scenario.evaluation_time;
    if (scenario.current_subject_digest)
      fixture.snapshot.binding.subject.content_digest = scenario.current_subject_digest;
    const authority = executorFixtureAuthority(fixture.journal, fixture.snapshot, fixture.request);
    expect(validateExecutorContext(fixture.request, fixture.journal, fixture.snapshot, authority)).toMatchObject({
      ok: false,
      diagnostics: [{ code: scenario.expected_preflight }],
    });
  });
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
    'ask_effect',
    'wrong_completion_effect',
    'stale_verifier',
    'same_actor',
    'missing_evidence',
    'missing_interruption',
    'nonterminal',
    'changed_usage',
  ])('rejects resealed semantic failure %s', async (mutation) => {
    const request = await json('upstream/gaap/agent-run-request.json');
    const receipt = (await json(
      `upstream/gaap/${mutation === 'missing_interruption' ? 'interrupted' : 'completed'}.json`,
    )) as GaapReceipt;
    const body = receipt.body;
    for (const event of body.events) {
      if (mutation === 'ask_effect' && event.event_type === 'protected_effect_decision' && event.gate === 'permission')
        event.decision.outcome = 'ask';
      if (
        mutation === 'wrong_completion_effect' &&
        event.event_type === 'protected_effect_decision' &&
        event.decision.code === 'workflow.completion_authorized'
      )
        event.protected_effect_digest = 'sha256:' + '0'.repeat(64);
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
    expect(validateGaapReceipt(receipt, request).ok).toBe(false);
  });
});
