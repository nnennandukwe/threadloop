/** Deliberately synthetic signed output for real process/storage failure tests. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildGaapRequest,
  canonicalExecutorJson,
  mapGaapResult,
  type ExecutorRequest,
} from 'threadloop-contracts/executor';
import { gaapFixture, signGaapTestStatement } from './gaap.js';
import { observeGaapWorkspace } from '../../src/adapters/fs/gaap-files.js';
import { gaapContentDigest, gaapObjectDigest } from '../../src/domain/gaap-content.js';
import { canonicalGaapJson, parseGaapJson } from '../../src/domain/gaap-json.js';

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
const request = parseGaapJson(Buffer.concat(chunks)) as ExecutorRequest;
const mode = process.env.TEST_GAAP_MODE;
if (mode === 'timeout') await new Promise(() => setInterval(() => {}, 1000));
if (mode === 'nonzero') process.exit(9);
if (mode === 'malformed') {
  process.stdout.write('{}\n');
  process.exit(0);
}
const mapped = buildGaapRequest(request, JSON.parse(process.env.TEST_GAAP_MAPPING!));
if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
const fixture = await gaapFixture();
const statement = fixture.statement;
const predicate = statement.predicate;
predicate.request = mapped.value;
predicate.implementation = JSON.parse(process.env.TEST_GAAP_IMPLEMENTATION!) as typeof predicate.implementation;
const physical = observeGaapWorkspace(process.cwd());
const digest = 'sha256:' + physical.digest;
predicate.observed_subject = { ...mapped.value.subject, digest };
statement.subject = [{ name: mapped.value.subject.locator, digest: { sha256: physical.digest } }];
const output = Buffer.from('synthetic independent test output');
const outputDigest = gaapContentDigest(output);
const evidence = [
  { evidence_type: 'command_output' as const, digest: outputDigest, locator: null },
  { evidence_type: 'artifact' as const, digest, locator: null },
];
const usage = { cost_micros: 0, elapsed_ms: 0, model_tokens: 0, tool_calls: 0 };
const body = predicate.receipt.body;
body.request_id = mapped.value.request_id;
body.run_id = mapped.value.run_id;
body.request_digest = gaapObjectDigest(mapped.value);
body.initial_subject_digest = digest;
body.resulting_subject_digest = digest;
body.usage = structuredClone(usage);
body.events = [
  { event_type: 'status_transition', from: 'accepted', to: 'planning', reason: null, sequence: 1 },
  { event_type: 'plan_recorded', plan_digest: gaapContentDigest('synthetic plan'), sequence: 2 },
  { event_type: 'status_transition', from: 'planning', to: 'executing', reason: null, sequence: 3 },
  { event_type: 'status_transition', from: 'executing', to: 'verifying', reason: null, sequence: 4 },
  {
    event_type: 'verification',
    subject_digest: digest,
    verifier_id: 'test-verifier',
    implementer_id: 'test-implementer',
    verdict: 'PASS',
    evidence,
    sequence: 5,
  },
  {
    event_type: 'protected_effect_decision',
    subject_digest: digest,
    protected_effect_digest: digest,
    decision_id: 'test-completion',
    gate: 'workflow',
    decision: { outcome: 'allow', code: 'workflow.completion_authorized', effects: ['record_completion'] },
    sequence: 6,
  },
  {
    event_type: 'status_transition',
    from: 'verifying',
    to: 'completed',
    reason: 'workflow.completion_authorized',
    sequence: 7,
  },
];
body.events.splice(4, 0, { event_type: 'usage', usage, sequence: 0 });
body.events.forEach((event, index) => {
  event.sequence = index + 1;
});
predicate.effects = [];
predicate.snapshot_digests = [digest];
const blobs = new Map<string, Buffer>([
  [digest, Buffer.from(canonicalGaapJson(physical.manifest))],
  [outputDigest, output],
]);
for (const [name, metadata] of Object.entries(physical.manifest)) {
  const entry = metadata as { kind: string; digest: string };
  if (entry.kind === 'file') blobs.set(entry.digest, readFileSync(path.join(process.cwd(), name)));
}
predicate.blob_digests = [...blobs.keys()].sort();
predicate.receipt.receipt_digest = gaapObjectDigest(body);
if (['ask', 'block'].includes(mode ?? '')) {
  const refused = await gaapFixture('ask');
  const effect = refused.statement.predicate.effects[0]!;
  const proposed = effect.request;
  proposed.run_id = mapped.value.run_id;
  proposed.agent_run_request_digest = body.request_digest;
  proposed.subject = structuredClone(mapped.value.subject);
  proposed.capability = structuredClone(mapped.value.requested_capability);
  proposed.policies = structuredClone(mapped.value.policies);
  proposed.resource_budget_digest = gaapObjectDigest(mapped.value.resource_budget);
  proposed.approval_context = structuredClone(mapped.value.approval_context);
  const effectDigest = gaapObjectDigest(proposed);
  const result = effect.result.body;
  result.run_id = mapped.value.run_id;
  result.agent_run_request_digest = body.request_digest;
  result.effect_request_digest = effectDigest;
  result.observed_pre_effect_subject = structuredClone(mapped.value.subject);
  result.observed_capability = structuredClone(mapped.value.requested_capability);
  result.decision.effect_request_digest = effectDigest;
  result.decision.subject_digest = digest;
  if (mode === 'block') {
    result.execution_status = 'denied';
    result.reason = 'permission.denied';
    result.decision.decision = { outcome: 'block', code: 'permission.denied', effects: [] };
  }
  effect.result.result_digest = gaapObjectDigest(result);
  predicate.effects = [effect];
  body.terminal_status = 'blocked';
  body.terminal_reason = result.reason!;
  body.events = body.events.slice(0, 3);
  body.events.push(
    { event_type: 'usage', usage: structuredClone(usage), sequence: 0 },
    {
      event_type: 'protected_effect_decision',
      ...structuredClone(result.decision),
      protected_effect_digest: effectDigest,
      sequence: 0,
    },
  );
  // The signed ledger uses its published fields rather than the result's effect_request_digest alias.
  const decision = body.events.at(-1)!;
  Reflect.deleteProperty(decision, 'effect_request_digest');
  if (mode === 'ask')
    body.events.push({
      event_type: 'status_transition',
      from: 'executing',
      to: 'awaiting_authority',
      reason: result.reason,
      sequence: 0,
    });
  body.events.push({
    event_type: 'status_transition',
    from: mode === 'ask' ? 'awaiting_authority' : 'executing',
    to: 'blocked',
    reason: result.reason,
    sequence: 0,
  });
  for (const [identity, bytes] of refused.blobs) blobs.set(identity, bytes);
}
if (mode === 'failed' || mode === 'interrupted') {
  body.terminal_status = mode;
  body.terminal_reason = 'synthetic.' + mode;
  body.events = body.events.slice(0, 3);
  body.events.push({ event_type: 'usage', usage: structuredClone(usage), sequence: 0 });
  if (mode === 'interrupted')
    body.events.push({
      event_type: 'interruption',
      reason: 'synthetic.interrupted',
      actor_id: null,
      evidence: { evidence_type: 'interruption', digest: outputDigest, locator: null },
      sequence: 0,
    });
  body.events.push({
    event_type: 'status_transition',
    from: 'executing',
    to: mode,
    reason: body.terminal_reason,
    sequence: 0,
  });
}
body.events.forEach((event, index) => {
  event.sequence = index + 1;
});
predicate.blob_digests = [...blobs.keys()].sort();
predicate.receipt.receipt_digest = gaapObjectDigest(body);
const directory = process.env.THREADLOOP_GAAP_EVIDENCE_DIRECTORY!;
mkdirSync(path.join(directory, 'blobs'));
for (const [identity, bytes] of blobs) writeFileSync(path.join(directory, 'blobs', identity.slice(7)), bytes);
if (mode === 'unknown_version') statement.predicateType += '-unknown';
if (mode === 'wrong_capability') statement.predicate.request.requested_capability.digest = 'sha256:' + 'f'.repeat(64);
let signed = signGaapTestStatement(statement);
if (mode === 'signature') {
  const envelope = JSON.parse(signed.toString()) as { signatures: Array<{ sig: string }> };
  envelope.signatures[0]!.sig = Buffer.alloc(64).toString('base64');
  signed = Buffer.from(JSON.stringify(envelope));
}
if (mode !== 'missing_envelope') writeFileSync(path.join(directory, 'envelope.json'), signed);
const initial = request.request.action_request.request.binding.subject;
const result = mapGaapResult(
  request,
  JSON.parse(process.env.TEST_GAAP_MAPPING!),
  Buffer.from(canonicalGaapJson(predicate.receipt)),
  { finished_at: new Date().toISOString(), resulting_subject: { ...initial, content_digest: physical.digest } },
);
if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
const encoded = canonicalExecutorJson(result.value);
if (!encoded.ok) throw new Error('Invalid test output');
process.stdout.write(encoded.value + '\n');
