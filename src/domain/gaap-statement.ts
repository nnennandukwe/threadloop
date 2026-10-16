import { Ajv2020 } from 'ajv/dist/2020.js';
import { validateGaapReceipt, type GaapRequest } from 'threadloop-contracts/executor';
import schema from '../contracts/gaap/terminal-run-v1.schema.json' with { type: 'json' };
import { VerifiedGaapEnvelope } from '../adapters/crypto/gaap-dsse.js';
import { canonicalGaapJson, GaapEvidenceError, parseGaapJson } from './gaap-json.js';
import { verifyGaapContent, type GaapBlobReader } from './gaap-content.js';
import { verifyGaapEffects } from './gaap-effects.js';
import type { GaapStatement } from './gaap-types.js';

const ajv = new Ajv2020({ strict: true, allErrors: false });
ajv.addFormat('uint64', { type: 'number', validate: (value: number) => Number.isSafeInteger(value) && value >= 0 });
ajv.addFormat('int32', {
  type: 'number',
  validate: (value: number) => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647,
});
ajv.addFormat('uint16', {
  type: 'number',
  validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 65535,
});
const shape = ajv.compile<GaapStatement>(schema);
const versions = [
  'gaap.agent-run-request/0.1.0',
  'gaap.terminal-run-receipt/0.1.0',
  'gaap.protected-effect-request/0.1.0',
  'gaap.protected-effect-result/0.1.0',
];

/** Signature, predicate, bindings and retained bytes verified independently of the producer process. */
export async function verifyGaapStatement(
  envelope: VerifiedGaapEnvelope,
  expected: GaapRequest,
  reader: GaapBlobReader,
  expectedImplementation: GaapStatement['predicate']['implementation'],
) {
  const value = parseGaapJson(envelope.payload, { integerLiterals: true });
  if (!shape(value))
    throw new GaapEvidenceError(
      'attestation.schema',
      'Signed evidence has an unsupported version or invalid predicate shape.',
    );
  normalizeTypedOptions(value);
  const predicate = value.predicate;
  if (canonicalGaapJson(predicate.implementation) !== canonicalGaapJson(expectedImplementation))
    throw new GaapEvidenceError(
      'attestation.implementation',
      'The signed implementation must match the independently selected producer policy.',
    );
  if (
    blankText(value) ||
    canonicalGaapJson(predicate.contract_versions) !== canonicalGaapJson(versions) ||
    canonicalGaapJson(predicate.request) !== canonicalGaapJson(expected)
  )
    throw new GaapEvidenceError(
      'attestation.request',
      'Signed evidence must bind the entire expected request and supported contracts.',
    );
  const ledger = validateGaapReceipt(predicate.receipt, expected);
  if (!ledger.ok)
    throw new GaapEvidenceError('attestation.ledger', ledger.diagnostics.map((item) => item.message).join(' '));
  const observed = predicate.observed_subject;
  if (
    observed.kind !== expected.subject.kind ||
    observed.locator !== expected.subject.locator ||
    value.subject[0]?.name !== observed.locator ||
    canonicalGaapJson(value.subject[0]?.digest) !== canonicalGaapJson({ sha256: observed.digest.slice(7) }) ||
    (predicate.receipt.body.terminal_status === 'completed' &&
      observed.digest !== predicate.receipt.body.resulting_subject_digest)
  )
    throw new GaapEvidenceError(
      'attestation.subject',
      'The statement must retain its exact physical and admitted subject identities.',
    );
  verifyGaapEffects(value);
  const content = await verifyGaapContent(value, reader);
  return { statement: value, signerFingerprints: [...envelope.signerFingerprints], ...content };
}
function blankText(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length === 0;
  if (value !== null && typeof value === 'object') return Object.values(value).some(blankText);
  return false;
}

/** Rust's v1 canonical identities serialize every Option as an explicit value or null. */
function normalizeTypedOptions(statement: GaapStatement): void {
  const predicate = statement.predicate;
  const evidence = (references: Array<{ locator?: string | null }>) => {
    for (const reference of references) reference.locator ??= null;
  };
  const approvals = (entries: GaapRequest['approval_context']) => evidence(entries.map((entry) => entry.evidence));
  approvals(predicate.request.approval_context);
  for (const event of predicate.receipt.body.events) {
    if (event.event_type === 'status_transition') event.reason ??= null;
    else if (event.event_type === 'approval_recorded') evidence([event.approval.evidence]);
    else if (event.event_type === 'interruption') {
      event.actor_id ??= null;
      evidence([event.evidence]);
    } else if (
      event.event_type === 'tool_execution' ||
      event.event_type === 'mutation' ||
      event.event_type === 'verification'
    )
      evidence(event.evidence);
  }
  for (const effect of predicate.effects) {
    effect.request.tool_schema_digest ??= null;
    approvals(effect.request.approval_context);
    const body = effect.result.body;
    body.observed_tool_schema_digest ??= null;
    body.observed_post_effect_subject ??= null;
    body.exit ??= null;
    body.executor ??= null;
    body.sandbox_profile ??= null;
    body.reason ??= null;
    evidence(body.evidence);
  }
}
