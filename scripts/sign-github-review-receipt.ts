import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../src/adapters/crypto/sha256.js';
import { signSigstoreStatement } from '../src/adapters/crypto/sigstore.js';
import { IN_TOTO_PAYLOAD_TYPE } from '../src/domain/attestation.js';
import { canonicalJson } from '../src/domain/canonical-json.js';
import {
  authorizeReviewReportForSigning,
  buildInTotoReviewStatement,
  canonicalizeSignedReviewReceiptArtifact,
  SIGNED_REVIEW_RECEIPT_MEDIA_TYPE,
} from '../src/domain/review.js';
import { positiveIntegerEnvironment, readReport, requiredEnvironment, sensorRunContext } from './sensor-environment.js';

const MAXIMUM_REPORT_BYTES = 10 * 1_024 * 1_024;
const run = sensorRunContext();
const outputPath = path.resolve(requiredEnvironment('THREADLOOP_OUTPUT_PATH'));
const report = await readReport(
  path.resolve(requiredEnvironment('THREADLOOP_REPORT_PATH')),
  MAXIMUM_REPORT_BYTES,
  'review',
);

const artifact = authorizeReviewReportForSigning(report, {
  receiptId: `review_${randomUUID()}`,
  sessionId: run.sessionId,
  planSha256: run.planSha256,
  pullRequestNumber: positiveIntegerEnvironment('THREADLOOP_PULL_REQUEST_NUMBER'),
  sourceRepository: run.sourceRepository,
  sourceRef: run.sourceRef,
  sourceHeadSha: run.sourceHead,
  runInvocationUri: run.runInvocationUri,
});
const canonicalArtifact = canonicalizeSignedReviewReceiptArtifact(artifact, sha256);
const statement = buildInTotoReviewStatement(canonicalArtifact.artifact, canonicalArtifact.sha256);
const bundle = await signSigstoreStatement(Buffer.from(canonicalJson(statement)), IN_TOTO_PAYLOAD_TYPE);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  canonicalJson({
    media_type: SIGNED_REVIEW_RECEIPT_MEDIA_TYPE,
    artifact: canonicalArtifact.artifact,
    bundle,
  }),
  { encoding: 'utf8', flag: 'wx' },
);
