import { describe, expect, it } from 'vitest';
import { collectGitHubReviewSnapshot, type GitHubGraphqlFetch } from '../../src/adapters/github/review-sensor.js';

const reviewedHead = 'a'.repeat(40);
const workflowHead = 'b'.repeat(40);
const planSha = 'c'.repeat(64);

function input() {
  return {
    sessionId: 'session_123',
    planSha256: planSha,
    pullRequestNumber: 42,
    sourceRepository: 'https://github.com/example/project',
    sourceRef: 'refs/heads/review-sensor',
    sourceHeadSha: workflowHead,
    runInvocationUri: 'https://github.com/example/project/actions/runs/123/attempts/1',
    token: 'test-token',
    observedAt: '2026-07-26T12:00:00.000Z',
    receiptId: 'report_123',
  };
}

describe('GitHub review sensor adapter', () => {
  it('paginates approvals and review threads into one provider-neutral snapshot', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const fetch: GitHubGraphqlFetch = (_url, init) => {
      const request = JSON.parse(requestBody(init)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      calls.push(request);
      const cursor = request.variables.cursor;
      if (request.query.includes('ReviewSnapshotReviews')) {
        return Promise.resolve(
          response({
            data: {
              repository: {
                pullRequest: {
                  number: 42,
                  url: 'https://github.com/example/project/pull/42',
                  headRefOid: reviewedHead,
                  baseRefName: 'main',
                  merged: false,
                  mergedAt: null,
                  reviewDecision: 'APPROVED',
                  reviews: {
                    nodes: [
                      {
                        author: { id: 'user-1', login: 'alice', __typename: 'User' },
                        state: cursor ? 'COMMENTED' : 'APPROVED',
                        commit: { oid: reviewedHead },
                        submittedAt: '2026-07-26T11:00:00.000Z',
                      },
                      ...(cursor
                        ? [
                            {
                              author: { id: 'user-2', login: 'bob', __typename: 'User' },
                              state: 'APPROVED',
                              commit: { oid: reviewedHead },
                              submittedAt: '2026-07-26T11:30:00.000Z',
                            },
                          ]
                        : []),
                    ],
                    pageInfo: {
                      hasNextPage: !cursor,
                      endCursor: cursor ? 'reviews-end' : 'reviews-next',
                    },
                  },
                },
              },
            },
          }),
        );
      }
      return Promise.resolve(
        response({
          data: {
            repository: {
              pullRequest: {
                number: 42,
                url: 'https://github.com/example/project/pull/42',
                headRefOid: reviewedHead,
                baseRefName: 'main',
                merged: false,
                mergedAt: null,
                reviewDecision: 'APPROVED',
                reviewThreads: {
                  nodes: [
                    {
                      id: cursor ? 'thread-2' : 'thread-1',
                      isResolved: Boolean(cursor),
                      isOutdated: false,
                      comments: {
                        nodes: [
                          {
                            url: `https://github.com/example/project/pull/42#discussion_${cursor ? '2' : '1'}`,
                            author: { login: 'reviewer', __typename: 'User' },
                            body: cursor ? 'Resolved' : 'Please fix this',
                            path: 'src/index.ts',
                            line: cursor ? 20 : 10,
                            originalLine: cursor ? 20 : 10,
                            createdAt: '2026-07-26T10:00:00.000Z',
                            updatedAt: '2026-07-26T10:30:00.000Z',
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: {
                    hasNextPage: !cursor,
                    endCursor: cursor ? 'threads-end' : 'threads-next',
                  },
                },
              },
            },
          },
        }),
      );
    };

    const snapshot = await collectGitHubReviewSnapshot(input(), fetch);

    expect(calls).toHaveLength(4);
    expect(snapshot).toMatchObject({
      receipt_id: 'report_123',
      plan_sha256: planSha,
      pull_request: { number: 42, head_sha: reviewedHead, merged: false },
      review: {
        decision: 'APPROVED',
        approvals: [
          { actor_login: 'alice', actor_type: 'User', commit_sha: reviewedHead },
          { actor_login: 'bob', actor_type: 'User', commit_sha: reviewedHead },
        ],
        threads: [
          { id: 'thread-1', body: 'Please fix this', resolved: false },
          { id: 'thread-2', body: 'Resolved', resolved: true },
        ],
      },
      source: { head_sha: workflowHead },
    });
  });

  it('fails closed on GraphQL errors and repeated pagination cursors', async () => {
    await expect(
      collectGitHubReviewSnapshot(input(), () => Promise.resolve(response({ errors: [{ message: 'forbidden' }] }))),
    ).rejects.toThrow('GitHub GraphQL review query failed: forbidden');

    await expect(
      collectGitHubReviewSnapshot(input(), (_url, init) => {
        const request = JSON.parse(requestBody(init)) as { query: string };
        if (request.query.includes('ReviewSnapshotReviews')) {
          return Promise.resolve(
            response({
              data: {
                repository: {
                  pullRequest: {
                    number: 42,
                    url: 'https://github.com/example/project/pull/42',
                    headRefOid: reviewedHead,
                    baseRefName: 'main',
                    merged: false,
                    mergedAt: null,
                    reviewDecision: null,
                    reviews: {
                      nodes: [],
                      pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
                    },
                  },
                },
              },
            }),
          );
        }
        return Promise.resolve(response({ data: { repository: { pullRequest: null } } }));
      }),
    ).rejects.toThrow('GitHub reviews pagination repeated cursor same-cursor');
  });

  it('describes the canonical GitHub URL requirement without excluding private repositories', async () => {
    await expect(
      collectGitHubReviewSnapshot(
        {
          ...input(),
          sourceRepository: 'https://gitlab.com/example/project',
        },
        () => {
          throw new Error('Repository validation must run before the GraphQL request.');
        },
      ),
    ).rejects.toThrow(
      'The GitHub review sensor requires a canonical https://github.com/<owner>/<repo> URL accessible to the workflow token.',
    );
  });
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestBody(init: RequestInit | undefined) {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected a JSON request body.');
  }
  return init.body;
}
