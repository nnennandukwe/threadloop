import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectGitHubReviewSnapshot } from '../src/adapters/github/review-sensor.js';
import { canonicalJson } from '../src/domain/canonical-json.js';
import { positiveIntegerEnvironment, requiredEnvironment } from './sensor-environment.js';

const sourceRepository = `${requiredEnvironment('GITHUB_SERVER_URL')}/${requiredEnvironment('GITHUB_REPOSITORY')}`;
const outputPath = path.resolve(requiredEnvironment('THREADLOOP_REPORT_PATH'));
const pullRequestNumber = positiveIntegerEnvironment('THREADLOOP_PULL_REQUEST_NUMBER');

const snapshot = await collectGitHubReviewSnapshot({
  sessionId: requiredEnvironment('THREADLOOP_SESSION_ID'),
  planSha256: requiredEnvironment('THREADLOOP_PLAN_SHA256'),
  pullRequestNumber,
  sourceRepository,
  sourceRef: requiredEnvironment('GITHUB_REF'),
  sourceHeadSha: requiredEnvironment('GITHUB_SHA'),
  runInvocationUri:
    `${sourceRepository}/actions/runs/${requiredEnvironment('GITHUB_RUN_ID')}` +
    `/attempts/${requiredEnvironment('GITHUB_RUN_ATTEMPT')}`,
  token: requiredEnvironment('GITHUB_TOKEN'),
  observedAt: new Date().toISOString(),
  receiptId: `report_${randomUUID()}`,
});

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, canonicalJson(snapshot), { encoding: 'utf8', flag: 'wx' });
