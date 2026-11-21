import { StateCorruptedError, ThreadloopError } from '../../contracts/errors.js';
import { canonicalJson } from '../../domain/canonical-json.js';
import { parseSignedReceiptPackage } from '../../domain/attestation.js';
import { parseSignedReviewReceiptPackage } from '../../domain/review.js';
import { workflowDigest } from '../../domain/workflow-selection-types.js';
import type {
  AdmittedObservation,
  AdmissionReply,
  Batch,
  GitObject,
  HostSource,
  Preparation,
  RawSource,
  RunSnapshot,
  SignedKind,
  SignedSource,
  VerifiedSource,
} from '../../domain/workflow-run.js';
import { MAX_SIGNED_RECEIPT_PACKAGE_BYTES } from '../../services/signed-receipt-files.js';
import { projectWorkflowHostSource } from '../../services/workflow-host-source.js';
import { projectWorkflowSignedSource } from '../../services/workflow-signed-source.js';
import { sha256 } from '../crypto/sha256.js';

type Bytes = { base64: string; sha256: string };
type SignedRecord = {
  kind: SignedKind;
  raw: Bytes;
  signer: SignedSource['signer'];
  canonical_digest: string;
  objects: { oid: string; kind: GitObject['kind']; base64: string }[];
};
type Local = Extract<HostSource, { kind: 'local-gate' }>;
type Review = Extract<HostSource, { kind: 'pre-pr-review' }>;
export type SourceRecord =
  | SignedRecord
  | (Omit<Local, 'artifact' | 'outputs'> & { artifact: Bytes; outputs: { path: string; content: Bytes }[] })
  | (Omit<Review, 'artifact'> & { artifact: Bytes });

function verifyBytes(raw: RawSource) {
  if (sha256(raw.bytes) !== raw.sha256)
    throw new StateCorruptedError('Workflow source content digest differs from its bytes.');
}
function pack(raw: RawSource): Bytes {
  verifyBytes(raw);
  return { base64: Buffer.from(raw.bytes).toString('base64'), sha256: raw.sha256 };
}
function bytes(encoded: string) {
  const value = Buffer.from(encoded, 'base64');
  if (value.toString('base64') !== encoded) throw new StateCorruptedError('Workflow source encoding is invalid.');
  return value;
}
function unpack(input: Bytes): RawSource {
  const raw = { bytes: bytes(input.base64), sha256: input.sha256 };
  verifyBytes(raw);
  return raw;
}
export function signedRaw(raw: RawSource) {
  if (raw.bytes.byteLength > MAX_SIGNED_RECEIPT_PACKAGE_BYTES)
    throw new ThreadloopError('SIGNED_RECEIPT_INVALID', 'The signed source exceeds the package byte limit.');
  return pack(raw);
}

export function retainSource(source: VerifiedSource): SourceRecord {
  switch (source.kind) {
    case 'local-gate':
      return {
        ...source,
        artifact: pack(source.artifact),
        outputs: source.outputs.map((output) => ({ path: output.path, content: pack(output.content) })),
      };
    case 'pre-pr-review':
      return { ...source, artifact: pack(source.artifact) };
    default: {
      const record: SignedRecord = {
        kind: source.kind,
        raw: signedRaw(source.raw),
        signer: source.signer,
        canonical_digest: source.parsed.packageSha256,
        objects:
          source.kind === 'signed-instruction'
            ? source.objects.map((o) => ({ oid: o.oid, kind: o.kind, base64: Buffer.from(o.bytes).toString('base64') }))
            : [],
      };
      const restored = restoreSource(record).verified;
      if (!('parsed' in restored) || canonicalJson(source.parsed) !== canonicalJson(restored.parsed)) {
        throw new StateCorruptedError('Authenticated package differs from the original source bytes.');
      }
      return record;
    }
  }
}

export function restoreSource(record: SourceRecord) {
  let verified: VerifiedSource;
  let key: string;
  let rawDigest: string;
  let canonicalDigest: string;
  let preparedId: string | null = null;
  if (record.kind === 'local-gate' || record.kind === 'pre-pr-review') {
    const artifact = unpack(record.artifact);
    key =
      record.kind === 'local-gate'
        ? 'local-gate:' + record.receipt.id
        : 'pre-pr-review:' +
          workflowDigest([record.producer_id, record.reviewer_id, record.producing, record.observed_at]);
    rawDigest = artifact.sha256;
    canonicalDigest = workflowDigest(record);
    verified =
      record.kind === 'local-gate'
        ? { ...record, artifact, outputs: record.outputs.map((o) => ({ path: o.path, content: unpack(o.content) })) }
        : { ...record, artifact };
  } else {
    const raw = unpack(record.raw);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes));
    const signer = record.signer;
    if (record.kind === 'signed-gate') {
      verified = { kind: record.kind, raw, signer, parsed: parseSignedReceiptPackage(value, sha256) };
    } else {
      const parsed = parseSignedReviewReceiptPackage(value, sha256);
      verified =
        record.kind === 'signed-review'
          ? { kind: record.kind, raw, signer, parsed }
          : {
              kind: record.kind,
              raw,
              signer,
              parsed,
              objects: record.objects.map((o) => ({ kind: o.kind, oid: o.oid, bytes: bytes(o.base64) })),
            };
    }
    preparedId = verified.parsed.artifact.receipt_id;
    key = preparedId;
    rawDigest = raw.sha256;
    canonicalDigest = verified.parsed.packageSha256;
    if (
      canonicalDigest !== record.canonical_digest ||
      (record.kind !== 'signed-instruction' && record.objects.length)
    ) {
      throw new StateCorruptedError('Workflow package identity differs from its stored package.');
    }
  }
  return { key, preparedId, rawDigest, canonicalDigest, verified };
}

export function projectAdmission(
  snapshot: RunSnapshot,
  source: ReturnType<typeof restoreSource>,
  prepared: Preparation | null,
  claimedBatch: Batch,
  lastSequence: number,
  admittedAt: string,
) {
  const { verified } = source;
  let batch: Batch;
  if ('raw' in verified) {
    if (
      !prepared ||
      prepared.target.kind !== verified.kind ||
      prepared.valid_until <= admittedAt ||
      prepared.prepared_at > admittedAt
    ) {
      throw new StateCorruptedError('Signed workflow evidence lacks a current preparation.');
    }
    batch = projectWorkflowSignedSource(verified, snapshot.genesis, prepared);
  } else {
    batch = projectWorkflowHostSource(verified, snapshot.genesis);
  }
  if (
    canonicalJson(batch) !== canonicalJson(claimedBatch) ||
    batch.measured_at > admittedAt ||
    (batch.valid_until !== null && batch.valid_until <= admittedAt) ||
    batch.binding.workflow_run_id !== snapshot.view.workflow_run_id ||
    batch.binding.graph_digest !== snapshot.view.graph_digest ||
    batch.binding.graph_schema_version !== snapshot.view.graph_schema_version ||
    batch.binding.state_version > snapshot.view.state_version ||
    canonicalJson(batch.workflow_policy) !== canonicalJson(snapshot.view.policy) ||
    canonicalJson(batch.evidence_policy) !== canonicalJson(snapshot.genesis.source_policies[verified.kind])
  ) {
    throw new StateCorruptedError('Workflow evidence projection differs from its source or bound run.');
  }
  const { payloads, ...context } = batch;
  const streamKey = (v: Omit<AdmittedObservation, 'source_id' | 'receipts'>) =>
    canonicalJson([v.stream, v.binding.subject, v.evidence_policy, v.workflow_policy]);
  const stream = streamKey(batch);
  const sameStream = (other: AdmittedObservation) => streamKey(other) === stream;
  const previous = snapshot.observations.find(sameStream);
  if (previous && previous.measured_at >= batch.measured_at) {
    throw new ThreadloopError(
      'TRANSITION_GUARD_FAILED',
      'Workflow evidence is older than or conflicts with an accepted measurement.',
      {
        details: { reason: 'stale_measurement', recovery: 'Prepare and collect a newer trusted observation.' },
      },
    );
  }
  const revision = snapshot.view.evidence_revision + 1;
  const identity = workflowDigest({
    run: snapshot.view.workflow_run_id,
    key: source.key,
    revision,
    raw: source.rawDigest,
    canonical: source.canonicalDigest,
  });
  const admission = 'wfa_' + identity;
  const acceptance = { id: admission, digest: workflowDigest({ identity, context, payloads }) };
  const receipts = payloads.map((payload, i) => ({
    id: 'wfe_' + workflowDigest([identity, i + 1]).slice(0, 60),
    workflow_run_id: batch.binding.workflow_run_id,
    graph_digest: batch.binding.graph_digest,
    source_state_version: batch.binding.state_version,
    subject: batch.binding.subject,
    sequence: lastSequence + i + 1,
    policy: batch.evidence_policy,
    workflow_policy: batch.workflow_policy,
    acceptance,
    valid_until: batch.valid_until,
    origin: { kind: 'observation' as const },
    payload,
    payload_digest: workflowDigest(payload),
  }));
  const observation: AdmittedObservation = { ...context, source_id: admission, receipts };
  const reply: AdmissionReply = {
    contract_version: 1,
    workflow_run_id: snapshot.view.workflow_run_id,
    state: snapshot.view.state,
    state_version: snapshot.view.state_version,
    admission_id: admission,
    raw_source_sha256: source.rawDigest,
    canonical_source_sha256: source.canonicalDigest,
    receipt_ids: receipts.map((r) => r.id),
    evidence_revision: revision,
  };
  return { observation, reply, sameStream };
}
