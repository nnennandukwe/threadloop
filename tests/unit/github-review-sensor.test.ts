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
        // Review.author is an Actor. Its immutable ID is a field of Node.
        expect(request.query).toMatch(/\.\.\. on Node\s*\{\s*id\s*\}/);
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

  it('checks the latest same-head human opinion against the full review history in prepared mode', async () => {
    const alice = { id: 'user-node-a', login: 'alice', __typename: 'User' };
    const bob = { id: 'user-node-b', login: 'bob', __typename: 'User' };
    const bot = { id: 'bot-node', login: 'check-bot', __typename: 'Bot' };
    const opinion = (id: string, author: typeof alice, state: string, minute: number, head = reviewedHead) => ({
      id,
      author,
      state,
      submittedAt: `2026-07-26T11:${String(minute).padStart(2, '0')}:00.000Z`,
      commit: { oid: head },
    });
    const earlier = opinion('10', alice, 'APPROVED', 10);
    const approving = opinion('11', bob, 'APPROVED', 11);
    const dismissed = opinion('12', alice, 'DISMISSED', 12);
    const comment = opinion('13', bob, 'COMMENTED', 13);
    const automated = opinion('14', bot, 'APPROVED', 14);
    const restored = opinion('15', alice, 'APPROVED', 15);
    const missing = opinion('16', alice, 'APPROVED', 16, workflowHead);

    const collect = async (history: unknown[], latest: unknown[]) => {
      const requested = new Set<string>();
      const snapshot = await collectGitHubReviewSnapshot(
        { ...input(), receiptId: 'wfr_1234567890abcdef1234567890abcdef' },
        (_url, init) => {
          const { query } = JSON.parse(requestBody(init)) as { query: string };
          const field = query.includes('latestOpinionatedReviews(')
            ? 'latestOpinionatedReviews'
            : query.includes('reviewThreads(')
              ? 'reviewThreads'
              : 'reviews';
          if (field === 'latestOpinionatedReviews') expect(query).toMatch(/writersOnly:\s*false/);
          requested.add(field);
          const nodes = field === 'reviews' ? history : field === 'latestOpinionatedReviews' ? latest : [];
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
                    [field]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
                  },
                },
              },
            }),
          );
        },
      );
      expect(requested).toEqual(new Set(['reviews', 'latestOpinionatedReviews', 'reviewThreads']));
      return snapshot.review.approvals.map((a) => a.actor_id).sort();
    };
    const history = [earlier, approving, dismissed, comment, automated];
    expect(await collect(history, [earlier, approving, automated])).toEqual([bob.id]);
    expect(await collect([...history, restored], [restored, approving, automated])).toEqual([alice.id, bob.id]);
    expect(await collect([...history, { ...dismissed, state: 'CHANGES_REQUESTED' }], [earlier, approving])).toEqual([
      bob.id,
    ]);
    expect(await collect([...history, missing], [missing, approving])).toEqual([bob.id]);
    expect(await collect([earlier, { ...dismissed, submittedAt: earlier.submittedAt }], [earlier])).toEqual([]);
    expect(await collect([earlier, { ...dismissed, author: null }], [earlier])).toEqual([]);
    expect(await collect([earlier], [earlier, { ...dismissed, author: null }])).toEqual([]);
  });

  it('refuses a prepared review when the pull request changes across pages or a latest-opinion page is missing', async () => {
    const run = { ...input(), receiptId: 'wfr_1234567890abcdef1234567890abcdef' };
    for (const failure of ['changed head', 'missing cursor'] as const) {
      const fetch: GitHubGraphqlFetch = (_url, init) => {
        const { query, variables } = JSON.parse(requestBody(init)) as {
          query: string;
          variables: { cursor: string | null };
        };
        expect(query).toContain('latestOpinionatedReviews(');
        return Promise.resolve(
          response({
            data: {
              repository: {
                pullRequest: {
                  number: 42,
                  url: 'https://github.com/example/project/pull/42',
                  headRefOid: variables.cursor ? workflowHead : reviewedHead,
                  baseRefName: 'main',
                  merged: false,
                  mergedAt: null,
                  reviewDecision: 'APPROVED',
                  latestOpinionatedReviews: {
                    nodes: [],
                    pageInfo: {
                      hasNextPage: !variables.cursor,
                      endCursor: failure === 'missing cursor' ? null : 'next',
                    },
                  },
                },
              },
            },
          }),
        );
      };
      await expect(collectGitHubReviewSnapshot(run, fetch)).rejects.toThrow(
        failure === 'changed head' ? /changed while/ : /omitted its next cursor/,
      );
    }
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

  it('reports the HTTP status when an error response is not JSON', async () => {
    await expect(
      collectGitHubReviewSnapshot(input(), () =>
        Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 })),
      ),
    ).rejects.toThrow('GitHub GraphQL review query failed: HTTP 502');
  });

  it('leaves out approvals from deleted accounts or on commits GitHub no longer has', async () => {
    const pullRequest = (connection: 'reviews' | 'reviewThreads', nodes: unknown[]) => ({
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
            [connection]: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    });
    const approval = (author: unknown, commit: unknown) => ({
      author,
      state: 'APPROVED',
      commit,
      submittedAt: '2026-07-26T11:00:00.000Z',
    });
    const snapshot = await collectGitHubReviewSnapshot(input(), (_url, init) =>
      Promise.resolve(
        response(
          (JSON.parse(requestBody(init)) as { query: string }).query.includes('ReviewSnapshotReviews')
            ? pullRequest('reviews', [
                approval(null, { oid: reviewedHead }),
                approval({ id: 'user-1', login: 'alice', __typename: 'User' }, null),
                approval({ id: 'user-2', login: 'bob', __typename: 'User' }, { oid: reviewedHead }),
              ])
            : pullRequest('reviewThreads', []),
        ),
      ),
    );

    expect(snapshot.review.approvals.map((entry) => entry.actor_login)).toEqual(['bob']);
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
