import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../src/adapters/crypto/sha256.js';
import { signSigstoreStatement } from '../src/adapters/crypto/sigstore.js';
import { canonicalJson } from '../src/domain/canonical-json.js';
import {
  authorizeReviewReportForSigning,
  buildInTotoReviewStatement,
  canonicalizeSignedReviewReceiptArtifact,
  REVIEW_IN_TOTO_PAYLOAD_TYPE,
  SIGNED_REVIEW_RECEIPT_MEDIA_TYPE,
} from '../src/domain/review.js';
import { positiveIntegerEnvironment, requiredEnvironment } from './sensor-environment.js';

const MAXIMUM_REPORT_BYTES = 10 * 1_024 * 1_024;
const reportPath = path.resolve(requiredEnvironment('THREADLOOP_REPORT_PATH'));
const outputPath = path.resolve(requiredEnvironment('THREADLOOP_OUTPUT_PATH'));
const sourceRepository = `${requiredEnvironment('GITHUB_SERVER_URL')}/${requiredEnvironment('GITHUB_REPOSITORY')}`;
const pullRequestNumber = positiveIntegerEnvironment('THREADLOOP_PULL_REQUEST_NUMBER');
const runInvocationUri =
  `${sourceRepository}/actions/runs/${requiredEnvironment('GITHUB_RUN_ID')}` +
  `/attempts/${requiredEnvironment('GITHUB_RUN_ATTEMPT')}`;

const metadata = await stat(reportPath);
if (!metadata.isFile() || metadata.size > MAXIMUM_REPORT_BYTES) {
  throw new Error(`Captured review report must be a regular file no larger than ${MAXIMUM_REPORT_BYTES} bytes.`);
}
const reportJson = await readFile(reportPath, 'utf8');
if (Buffer.byteLength(reportJson) !== metadata.size) {
  throw new Error('Captured review report changed while it was being read.');
}
let report: unknown;
try {
  report = JSON.parse(reportJson) as unknown;
} catch {
  throw new Error('Captured review report must contain JSON.');
}

const artifact = authorizeReviewReportForSigning(report, {
  receiptId: `review_${randomUUID()}`,
  sessionId: requiredEnvironment('THREADLOOP_SESSION_ID'),
  planSha256: requiredEnvironment('THREADLOOP_PLAN_SHA256'),
  pullRequestNumber,
  sourceRepository,
  sourceRef: requiredEnvironment('GITHUB_REF'),
  sourceHeadSha: requiredEnvironment('GITHUB_SHA'),
  runInvocationUri,
});
const canonicalArtifact = canonicalizeSignedReviewReceiptArtifact(artifact, sha256);
const statement = buildInTotoReviewStatement(canonicalArtifact.artifact, canonicalArtifact.sha256);
const bundle = await signSigstoreStatement(Buffer.from(canonicalJson(statement)), REVIEW_IN_TOTO_PAYLOAD_TYPE);

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
