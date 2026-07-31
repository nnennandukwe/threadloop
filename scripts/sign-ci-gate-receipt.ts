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
  SIGNED_RECEIPT_MEDIA_TYPE_V2,
  type GitHubGateJobResult,
} from '../src/domain/attestation.js';
import { canonicalJson } from '../src/domain/canonical-json.js';
import { canonicalizeProofPlan } from '../src/domain/proof.js';
import { requiredEnvironment } from './sensor-environment.js';

const MAXIMUM_REPORT_BYTES = 1_048_576;

const sessionId = requiredEnvironment('THREADLOOP_SESSION_ID');
const planSha256 = requiredEnvironment('THREADLOOP_PLAN_SHA256');
const gateId = requiredEnvironment('THREADLOOP_GATE_ID');
const gateJson = requiredEnvironment('THREADLOOP_GATE_JSON');
const reportPath = path.resolve(requiredEnvironment('THREADLOOP_REPORT_PATH'));
const outputPath = path.resolve(requiredEnvironment('THREADLOOP_OUTPUT_PATH'));
const jobResult = parseJobResult(requiredEnvironment('THREADLOOP_GATE_JOB_RESULT'));
const sourceRepository = `${requiredEnvironment('GITHUB_SERVER_URL')}/${requiredEnvironment('GITHUB_REPOSITORY')}`;
const sourceRef = requiredEnvironment('GITHUB_REF');
const sourceHead = requiredEnvironment('GITHUB_SHA');
const runInvocationUri =
  `${sourceRepository}/actions/runs/${requiredEnvironment('GITHUB_RUN_ID')}` +
  `/attempts/${requiredEnvironment('GITHUB_RUN_ATTEMPT')}`;

if (!/^session_[A-Za-z0-9_-]+$/.test(sessionId)) {
  throw new Error('THREADLOOP_SESSION_ID must be a ThreadLoop session id.');
}
if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository)) {
  throw new Error(
    'The reusable sensor requires a canonical https://github.com/<owner>/<repo> URL accessible to the workflow.',
  );
}
if (!/^[a-f0-9]{64}$/.test(planSha256)) {
  throw new Error('THREADLOOP_PLAN_SHA256 must be 64 lowercase hexadecimal characters.');
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(gateId)) {
  throw new Error('THREADLOOP_GATE_ID is invalid.');
}
if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(sourceRef)) {
  throw new Error('The reusable sensor accepts only branch refs.');
}
if (!/^[a-f0-9]{40}$/.test(sourceHead)) {
  throw new Error('GITHUB_SHA must be a full lowercase commit SHA.');
}

const parsedGate = JSON.parse(gateJson) as unknown;
const gate = canonicalizeProofPlan(
  { acceptance_criteria: ['Execute the caller-declared CI gate'], gates: [parsedGate] },
  sha256,
).plan.gates[0];
if (!gate || gate.id !== gateId || canonicalJson(gate) !== canonicalJson(parsedGate)) {
  throw new Error('THREADLOOP_GATE_JSON must be the exact declared gate identified by THREADLOOP_GATE_ID.');
}

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
    media_type: SIGNED_RECEIPT_MEDIA_TYPE_V2,
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
