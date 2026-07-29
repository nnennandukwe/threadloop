import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import * as reviewDomain from '../../src/domain/review.js';
import type { SignedReviewReceiptArtifact } from '../../src/domain/review.js';

const headSha = 'a'.repeat(40);
const workflowSha = 'c'.repeat(40);
const planSha = 'b'.repeat(64);

function reviewArtifact(): SignedReviewReceiptArtifact {
  return {
    schema_version: 1,
    receipt_id: 'review_123',
    session_id: 'session_123',
    plan_sha256: planSha,
    pull_request: {
      number: 42,
      url: 'https://github.com/example/project/pull/42',
      head_sha: headSha,
      base_ref: 'main',
      merged: true,
      merged_at: '2026-07-26T12:00:00.000Z',
    },
    review: {
      decision: 'APPROVED',
      approvals: [
        {
          actor_id: 'MDQ6VXNlcjE=',
          actor_login: 'reviewer',
          actor_type: 'User',
          state: 'APPROVED',
          commit_sha: headSha,
          submitted_at: '2026-07-26T11:00:00.000Z',
        },
      ],
      threads: [
        {
          id: 'PRRT_1',
          url: 'https://github.com/example/project/pull/42#discussion_r1',
          author_login: 'reviewer',
          author_type: 'User',
          body: 'Resolved concern',
          path: 'src/index.ts',
          line: 12,
          resolved: true,
          outdated: false,
          created_at: '2026-07-26T10:00:00.000Z',
          updated_at: '2026-07-26T10:30:00.000Z',
        },
      ],
    },
    observed_at: '2026-07-26T12:01:00.000Z',
    source: {
      repository: 'https://github.com/example/project',
      ref: 'refs/heads/issue-42/review-audit-handoff',
      head_sha: workflowSha,
      run_invocation_uri: 'https://github.com/example/project/actions/runs/123/attempts/1',
    },
    sensor: {
      name: 'threadloop-github-actions-review',
      contract_version: 1,
    },
  };
}

describe('signed review evidence', () => {
  it('canonicalizes a provider-neutral review snapshot and binds it to an in-toto statement', () => {
    const canonicalize = Reflect.get(reviewDomain, 'canonicalizeSignedReviewReceiptArtifact') as (
      value: unknown,
      digest: typeof sha256,
    ) => { artifact: ReturnType<typeof reviewArtifact>; json: string; sha256: string };
    const buildStatement = Reflect.get(reviewDomain, 'buildInTotoReviewStatement') as (
      artifact: ReturnType<typeof reviewArtifact>,
      artifactSha256: string,
    ) => unknown;

    expect(typeof canonicalize).toBe('function');
    expect(typeof buildStatement).toBe('function');
    const canonical = canonicalize(reviewArtifact(), sha256);
    const statement = buildStatement(canonical.artifact, canonical.sha256);

    expect(canonical.json).toBe(canonicalJson(reviewArtifact()));
    expect(statement).toMatchObject({
      subject: [
        {
          name: 'https://github.com/example/project',
          digest: { gitCommit: headSha },
        },
        {
          name: 'threadloop-review-snapshot.json',
          digest: { sha256: canonical.sha256 },
        },
      ],
      predicate: {
        receipt_type: 'review',
        session_id: 'session_123',
        subject_head_sha: headSha,
      },
    });
  });

  it('revalidates an observed report against the trusted signing context', () => {
    const report = reviewArtifact();
    const authorized = reviewDomain.authorizeReviewReportForSigning(report, {
      receiptId: 'review_authoritative',
      sessionId: 'session_123',
      planSha256: planSha,
      pullRequestNumber: 42,
      sourceRepository: 'https://github.com/example/project',
      sourceRef: 'refs/heads/issue-42/review-audit-handoff',
      sourceHeadSha: workflowSha,
      runInvocationUri: 'https://github.com/example/project/actions/runs/123/attempts/1',
    });

    expect(authorized.receipt_id).toBe('review_authoritative');
    expect(authorized.pull_request.head_sha).toBe(headSha);
    expect(authorized.source.head_sha).toBe(workflowSha);
    expect(() =>
      reviewDomain.authorizeReviewReportForSigning(report, {
        receiptId: 'review_authoritative',
        sessionId: 'session_other',
        planSha256: planSha,
        pullRequestNumber: 42,
        sourceRepository: 'https://github.com/example/project',
        sourceRef: 'refs/heads/issue-42/review-audit-handoff',
        sourceHeadSha: workflowSha,
        runInvocationUri: 'https://github.com/example/project/actions/runs/123/attempts/1',
      }),
    ).toThrow('package.artifact.session_id does not match the trusted signing context');
  });

  it('reports only unresolved current threads as blocking findings', () => {
    const evaluate = Reflect.get(reviewDomain, 'reviewEvidenceFromArtifact') as (
      artifact: ReturnType<typeof reviewArtifact>,
      currentHead: string,
    ) => reviewDomain.ReviewEvidence;
    const artifact = reviewArtifact();
    artifact.review.threads.push(
      {
        ...artifact.review.threads[0]!,
        id: 'PRRT_2',
        body: 'Current blocker',
        resolved: false,
      },
      {
        ...artifact.review.threads[0]!,
        id: 'PRRT_3',
        body: 'Outdated concern',
        resolved: false,
        outdated: true,
      },
    );

    expect(typeof evaluate).toBe('function');
    expect(evaluate(artifact, headSha)).toMatchObject({
      status: 'current',
      snapshotId: 'review_123',
      blockingFindings: [{ id: 'PRRT_2', body: 'Current blocker' }],
      approvals: [{ actorType: 'User', commitSha: headSha }],
      merged: true,
    });
  });

  it('accepts only a same-HEAD GitHub User approval as human authority', () => {
    const evidence = reviewDomain.reviewEvidenceFromArtifact(reviewArtifact(), headSha);
    expect(reviewDomain.hasCurrentHumanApproval(evidence)).toBe(true);
    expect(
      reviewDomain.hasCurrentHumanApproval({
        ...evidence,
        approvals: evidence.approvals.map((approval) => ({ ...approval, actorType: 'Bot' })),
      }),
    ).toBe(false);
    expect(
      reviewDomain.hasCurrentHumanApproval({
        ...evidence,
        approvals: evidence.approvals.map((approval) => ({ ...approval, actorType: 'Organization' })),
      }),
    ).toBe(false);
    expect(
      reviewDomain.hasCurrentHumanApproval({
        ...evidence,
        approvals: evidence.approvals.map((approval) => ({ ...approval, commitSha: 'd'.repeat(40) })),
      }),
    ).toBe(false);
  });
});
