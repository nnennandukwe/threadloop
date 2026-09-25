import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../src/adapters/crypto/sha256.js';
import { signSigstoreStatement } from '../src/adapters/crypto/sigstore.js';
import {
  authorizeGateReportForSigning,
  buildInTotoReceiptStatement,
  canonicalizeSignedGateReceiptArtifact,
  IN_TOTO_PAYLOAD_TYPE,
  signedReceiptMediaType,
  type GitHubGateJobResult,
} from '../src/domain/attestation.js';
import { canonicalJson } from '../src/domain/canonical-json.js';
import { gateSensorContext, requiredEnvironment } from './sensor-environment.js';

const MAXIMUM_REPORT_BYTES = 1_048_576;

const { sessionId, planSha256, gate, sourceRepository, sourceRef, sourceHead, runInvocationUri } = gateSensorContext();
const reportPath = path.resolve(requiredEnvironment('THREADLOOP_REPORT_PATH'));
const outputPath = path.resolve(requiredEnvironment('THREADLOOP_OUTPUT_PATH'));
const jobResult = parseJobResult(requiredEnvironment('THREADLOOP_GATE_JOB_RESULT'));

const reportMetadata = await stat(reportPath);
if (!reportMetadata.isFile() || reportMetadata.size > MAXIMUM_REPORT_BYTES) {
  throw new Error(`Captured gate report must be a regular file no larger than ${MAXIMUM_REPORT_BYTES} bytes.`);
}
const reportJson = await readFile(reportPath, 'utf8');
if (Buffer.byteLength(reportJson) !== reportMetadata.size) {
  throw new Error('Captured gate report changed while it was being read.');
}
let report: unknown;
try {
  report = JSON.parse(reportJson) as unknown;
} catch {
  throw new Error('Captured gate report must contain JSON.');
}

const artifact = authorizeGateReportForSigning(report, {
  receiptId: `receipt_${randomUUID()}`,
  sessionId,
  planSha256,
  gate,
  sourceRepository,
  sourceRef,
  sourceHeadSha: sourceHead,
  runInvocationUri,
  runnerOs: requiredEnvironment('RUNNER_OS'),
  runnerArch: requiredEnvironment('RUNNER_ARCH'),
  nodeVersion: process.version,
  jobResult,
});
const canonicalArtifact = canonicalizeSignedGateReceiptArtifact(artifact, sha256);
const statement = buildInTotoReceiptStatement(canonicalArtifact.artifact, canonicalArtifact.sha256);
const bundle = await signSigstoreStatement(Buffer.from(canonicalJson(statement)), IN_TOTO_PAYLOAD_TYPE);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  canonicalJson({
    // Derived from the artifact rather than pinned, because the reader enforces that the media type and the
    // artifact's schema_version agree. Hardcoding it would make a v1 report sign into an unimportable package.
    media_type: signedReceiptMediaType(canonicalArtifact.artifact.schema_version),
    artifact: canonicalArtifact.artifact,
    bundle,
  }),
  { encoding: 'utf8', flag: 'wx' },
);

if (artifact.result !== 'passed') {
  process.exitCode = artifact.exit_status && artifact.exit_status > 0 ? artifact.exit_status : 1;
}

function parseJobResult(value: string): GitHubGateJobResult {
  if (value === 'success' || value === 'failure' || value === 'cancelled') {
    return value;
  }
  throw new Error('THREADLOOP_GATE_JOB_RESULT must be success, failure, or cancelled.');
}
