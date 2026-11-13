import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectGitHubReviewSnapshot } from '../src/adapters/github/review-sensor.js';
import { canonicalJson } from '../src/domain/canonical-json.js';
import { positiveIntegerEnvironment, requiredEnvironment, sensorRunContext } from './sensor-environment.js';

const run = sensorRunContext();
const outputPath = path.resolve(requiredEnvironment('THREADLOOP_REPORT_PATH'));

const snapshot = await collectGitHubReviewSnapshot({
  sessionId: run.sessionId,
  planSha256: run.planSha256,
  pullRequestNumber: positiveIntegerEnvironment('THREADLOOP_PULL_REQUEST_NUMBER'),
  sourceRepository: run.sourceRepository,
  sourceRef: run.sourceRef,
  sourceHeadSha: run.sourceHead,
  runInvocationUri: run.runInvocationUri,
  token: requiredEnvironment('GITHUB_TOKEN'),
  observedAt: new Date().toISOString(),
  receiptId: `report_${randomUUID()}`,
});

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, canonicalJson(snapshot), { encoding: 'utf8', flag: 'wx' });
