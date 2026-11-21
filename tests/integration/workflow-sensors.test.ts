import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { parseSignedReceiptPackage } from '../../src/domain/attestation.js';
import { parseSignedReviewReceiptPackage } from '../../src/domain/review.js';
import { fixtureBranch, fixtureRepository, gateArtifact, signedGatePackage } from '../fixtures/receipts.js';
import { cleanupTemporaryState, makeTempDir } from '../helpers/session.js';

vi.mock('../../src/adapters/crypto/sigstore.js', async (original) => ({
  ...(await original<typeof import('../../src/adapters/crypto/sigstore.js')>()),
  signSigstoreStatement: (payload: Buffer, payloadType: string) => {
    const bundle = signedGatePackage().bundle;
    return { ...bundle, dsseEnvelope: { ...bundle.dsseEnvelope, payload: payload.toString('base64'), payloadType } };
  },
}));

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await cleanupTemporaryState();
});

it('collects a prepared review from GitHub responses and binds the same ID into both fixture-signed packages', async () => {
  const root = await makeTempDir();
  const report = path.join(root, 'review.json');
  const output = path.join(root, 'review-package.json');
  const preparedId = 'wfr_0123456789abcdef0123456789abcdef';
  const gate = { ...gateArtifact(), receipt_id: preparedId };
  const pullHead = 'd'.repeat(40);
  const env = {
    THREADLOOP_SESSION_ID: gate.session_id,
    THREADLOOP_PLAN_SHA256: gate.plan_sha256,
    THREADLOOP_PREPARED_RECEIPT_ID: preparedId,
    THREADLOOP_PULL_REQUEST_NUMBER: '42',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'example/project',
    GITHUB_REF: 'refs/heads/' + fixtureBranch,
    GITHUB_SHA: gate.source.head_sha,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_TOKEN: 'fixture-token',
    THREADLOOP_REPORT_PATH: report,
    THREADLOOP_OUTPUT_PATH: output,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const opinion = {
    id: 'r1',
    author: { id: 'user-1', login: 'human', __typename: 'User' },
    state: 'APPROVED',
    commit: { oid: pullHead },
    submittedAt: '2020-01-01T00:00:00.000Z',
  };
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    if (typeof init.body !== 'string') throw new Error('Expected a GraphQL request body.');
    const { query } = JSON.parse(init.body) as { query: string };
    const field = query.includes('reviewThreads(')
      ? 'reviewThreads'
      : query.includes('latestOpinionatedReviews(')
        ? 'latestOpinionatedReviews'
        : 'reviews';
    return Promise.resolve(
      Response.json({
        data: {
          repository: {
            pullRequest: {
              number: 42,
              url: fixtureRepository + '/pull/42',
              headRefOid: pullHead,
              baseRefName: 'main',
              merged: false,
              mergedAt: null,
              reviewDecision: 'APPROVED',
              [field]: {
                nodes: field === 'reviewThreads' ? [] : [opinion],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  await import('../../scripts/collect-github-review-snapshot.js');
  await import('../../scripts/sign-github-review-receipt.js');
  const reviewPackage = parseSignedReviewReceiptPackage(JSON.parse(await readFile(output, 'utf8')), sha256);
  expect(reviewPackage.artifact).toMatchObject({
    receipt_id: preparedId,
    pull_request: { head_sha: pullHead },
    review: { approvals: [{ actor_id: 'user-1' }] },
    source: { head_sha: gate.source.head_sha },
  });
  expect(fetch).toHaveBeenCalledTimes(3);

  const gateReport = path.join(root, 'gate-report.json');
  const gateOutput = path.join(root, 'gate-package.json');
  await writeFile(gateReport, JSON.stringify(gate));
  for (const [key, value] of Object.entries({
    THREADLOOP_REPORT_PATH: gateReport,
    THREADLOOP_OUTPUT_PATH: gateOutput,
    THREADLOOP_GATE_JOB_RESULT: 'success',
    THREADLOOP_GATE_ID: gate.gate.id,
    THREADLOOP_GATE_JSON: JSON.stringify(gate.gate),
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
  }))
    vi.stubEnv(key, value);
  await import('../../scripts/sign-ci-gate-receipt.js');
  const gatePackage = parseSignedReceiptPackage(JSON.parse(await readFile(gateOutput, 'utf8')), sha256);
  expect(gatePackage.artifact).toMatchObject({ receipt_id: preparedId, result: 'passed' });
});
