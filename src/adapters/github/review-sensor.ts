import { isPreparedReceiptId } from '../../domain/attestation.js';
import { canonicalizeSignedReviewReceiptArtifact, type SignedReviewReceiptArtifact } from '../../domain/review.js';
import { sha256 } from '../crypto/sha256.js';

export type GitHubGraphqlFetch = typeof fetch;

export interface CollectGitHubReviewSnapshotInput {
  sessionId: string;
  planSha256: string;
  pullRequestNumber: number;
  sourceRepository: string;
  sourceRef: string;
  sourceHeadSha: string;
  runInvocationUri: string;
  token: string;
  observedAt: string;
  receiptId: string;
}

type ReviewConnection = 'reviews' | 'latestOpinionatedReviews';
function reviewsQuery(field: ReviewConnection) {
  const writers = field === 'latestOpinionatedReviews' ? ', writersOnly: false' : '';
  return `
  query ReviewSnapshotReviews(
    $owner: String!
    $name: String!
    $number: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        url
        headRefOid
        baseRefName
        merged
        mergedAt
        reviewDecision
        ${field}(first: 100, after: $cursor${writers}) {
          nodes {
            id
            author { id login __typename }
            state
            commit { oid }
            submittedAt
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;
}

const THREADS_QUERY = `
  query ReviewSnapshotThreads(
    $owner: String!
    $name: String!
    $number: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        number
        url
        headRefOid
        baseRefName
        merged
        mergedAt
        reviewDecision
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            id
            isResolved
            isOutdated
            comments(first: 1) {
              nodes {
                url
                author { login __typename }
                body
                path
                line
                originalLine
                createdAt
                updatedAt
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

type PullRequestMetadata = {
  number: number;
  url: string;
  headRefOid: string;
  baseRefName: string;
  merged: boolean;
  mergedAt: string | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
};

export async function collectGitHubReviewSnapshot(
  input: CollectGitHubReviewSnapshotInput,
  request: GitHubGraphqlFetch = fetch,
): Promise<SignedReviewReceiptArtifact> {
  const repository = parseRepository(input.sourceRepository);
  const commonVariables = {
    owner: repository.owner,
    name: repository.name,
    number: input.pullRequestNumber,
  };
  const approvals: SignedReviewReceiptArtifact['review']['approvals'] = [];
  const threads: SignedReviewReceiptArtifact['review']['threads'] = [];
  let metadata: PullRequestMetadata | null = null;

  async function readReviews(field: ReviewConnection, accept: (review: Record<string, unknown>) => void) {
    await paginate(field, async (cursor) => {
      const pullRequest = await queryPullRequest(input, request, reviewsQuery(field), { ...commonVariables, cursor });
      metadata = assertStableMetadata(metadata, pullRequest);
      const connection = object(pullRequest[field], `GitHub ${field}`);
      for (const value of array(connection.nodes, `GitHub ${field}.nodes`)) {
        accept(object(value, 'GitHub pull request review'));
      }
      return pageInfo(connection.pageInfo, `GitHub ${field}`);
    });
  }

  if (isPreparedReceiptId(input.receiptId)) {
    const opinions: Opinion[] = [];
    const history: Opinion[] = [];
    await readReviews('latestOpinionatedReviews', (review) => {
      const entry = parseOpinion(review);
      if (entry) opinions.push(entry);
    });
    await readReviews('reviews', (review) => {
      const entry = parseOpinion(review);
      if (entry) history.push(entry);
    });
    const reviewed = metadata as PullRequestMetadata | null;
    if (reviewed) approvals.push(...currentApprovals(opinions, history, reviewed.headRefOid, input.observedAt));
  } else {
    await readReviews('reviews', (review) => {
      const approval = parseApproval(review);
      if (approval) approvals.push(approval);
    });
  }

  await paginate('review threads', async (cursor) => {
    const pullRequest = await queryPullRequest(input, request, THREADS_QUERY, {
      ...commonVariables,
      cursor,
    });
    metadata = assertStableMetadata(metadata, pullRequest);
    const reviewThreads = object(pullRequest.reviewThreads, 'GitHub pull request reviewThreads');
    const nodes = array(reviewThreads.nodes, 'GitHub pull request reviewThreads.nodes');
    for (const [index, value] of nodes.entries()) {
      const thread = object(value, `GitHub pull request reviewThreads.nodes[${index}]`);
      const comments = object(thread.comments, `GitHub review thread ${index}.comments`);
      const root = array(comments.nodes, `GitHub review thread ${index}.comments.nodes`)[0];
      if (!root) {
        throw new Error(`GitHub review thread ${text(thread.id, 'GitHub review thread id')} has no root comment.`);
      }
      const comment = object(root, `GitHub review thread ${index} root comment`);
      const author = nullableObject(comment.author, `GitHub review thread ${index} root comment author`);
      const line = comment.line ?? comment.originalLine;
      threads.push({
        id: text(thread.id, `GitHub review thread ${index}.id`),
        url: text(comment.url, `GitHub review thread ${index}.url`),
        author_login: author ? text(author.login, `GitHub review thread ${index}.author.login`) : null,
        author_type: author ? text(author.__typename, `GitHub review thread ${index}.author.__typename`) : null,
        body: text(comment.body, `GitHub review thread ${index}.body`),
        path: nullableText(comment.path, `GitHub review thread ${index}.path`),
        line: nullablePositiveInteger(line, `GitHub review thread ${index}.line`),
        resolved: boolean(thread.isResolved, `GitHub review thread ${index}.isResolved`),
        outdated: boolean(thread.isOutdated, `GitHub review thread ${index}.isOutdated`),
        created_at: text(comment.createdAt, `GitHub review thread ${index}.createdAt`),
        updated_at: text(comment.updatedAt, `GitHub review thread ${index}.updatedAt`),
      });
    }
    return pageInfo(reviewThreads.pageInfo, 'GitHub review threads');
  });

  const collectedMetadata = metadata as PullRequestMetadata | null;
  if (!collectedMetadata) {
    throw new Error('GitHub review snapshot did not return pull request metadata.');
  }
  return canonicalizeSignedReviewReceiptArtifact(
    {
      schema_version: 1,
      receipt_id: input.receiptId,
      session_id: input.sessionId,
      plan_sha256: input.planSha256,
      pull_request: {
        number: collectedMetadata.number,
        url: collectedMetadata.url,
        head_sha: collectedMetadata.headRefOid,
        base_ref: collectedMetadata.baseRefName,
        merged: collectedMetadata.merged,
        merged_at: collectedMetadata.mergedAt,
      },
      review: {
        decision: collectedMetadata.reviewDecision,
        approvals,
        threads,
      },
      observed_at: input.observedAt,
      source: {
        repository: input.sourceRepository,
        ref: input.sourceRef,
        head_sha: input.sourceHeadSha,
        run_invocation_uri: input.runInvocationUri,
      },
      sensor: {
        name: 'threadloop-github-actions-review',
        contract_version: 1,
      },
    },
    sha256,
  ).artifact;
}

type Approval = SignedReviewReceiptArtifact['review']['approvals'][number];

function parseApproval(review: Record<string, unknown>): Approval | null {
  if (review.state !== 'APPROVED' || review.author === null || review.commit === null) return null;
  const author = object(review.author, 'GitHub approval author');
  return {
    actor_id: text(author.id, 'GitHub approval author.id'),
    actor_login: text(author.login, 'GitHub approval author.login'),
    actor_type: text(author.__typename, 'GitHub approval author.__typename'),
    state: 'APPROVED',
    commit_sha: text(object(review.commit, 'GitHub approval commit').oid, 'GitHub approval commit.oid'),
    submitted_at: text(review.submittedAt, 'GitHub approval submittedAt'),
  };
}

interface Opinion {
  id: string;
  actorId: string | null;
  time: number;
  approval: Approval | null;
}

function parseOpinion(review: Record<string, unknown>): Opinion | null {
  if (review.state === 'COMMENTED' || review.state === 'PENDING') return null;
  if (!['APPROVED', 'DISMISSED', 'CHANGES_REQUESTED'].includes(text(review.state, 'GitHub review state'))) {
    throw new Error('GitHub returned an unknown review state.');
  }
  const time = Date.parse(text(review.submittedAt, 'GitHub review submittedAt'));
  if (!Number.isFinite(time)) throw new Error('GitHub returned an invalid review submission time.');
  const author = nullableObject(review.author, 'GitHub review author');
  return {
    id: text(review.id, 'GitHub review id'),
    actorId: author && text(author.id, 'GitHub review author.id'),
    time,
    approval: parseApproval(review),
  };
}

function currentApprovals(opinions: Opinion[], history: Opinion[], head: string, observedAt: string): Approval[] {
  // A dismissal can expose an older approval in latestOpinionatedReviews. The full history must independently
  // identify the same review as the actor's most recent opinion, with no later unidentified author or tie.
  const latest = new Map<string, Opinion>();
  let unidentifiedAt = opinions.reduce(
    (time, entry) => (entry.actorId === null ? Math.max(time, entry.time) : time),
    -Infinity,
  );
  for (const entry of history) {
    if (entry.actorId === null) {
      unidentifiedAt = Math.max(unidentifiedAt, entry.time);
      continue;
    }
    const previous = latest.get(entry.actorId);
    if (!previous || previous.time < entry.time) latest.set(entry.actorId, entry);
    else if (previous.time === entry.time) latest.set(entry.actorId, { ...entry, approval: null });
  }
  const seen = new Set<string>();
  const approvals: Approval[] = [];
  for (const opinion of opinions) {
    if (opinion.actorId === null) continue;
    if (seen.has(opinion.actorId)) throw new Error('GitHub returned multiple latest opinions for the same actor.');
    seen.add(opinion.actorId);
    const entry = latest.get(opinion.actorId);
    const approval = opinion.approval;
    if (
      approval?.actor_type === 'User' &&
      approval.commit_sha === head &&
      opinion.time <= Date.parse(observedAt) &&
      opinion.time > unidentifiedAt &&
      entry?.id === opinion.id &&
      entry.time === opinion.time &&
      entry.approval?.actor_type === 'User' &&
      entry.approval.commit_sha === head
    )
      approvals.push(approval);
  }
  return approvals;
}

async function queryPullRequest(
  input: CollectGitHubReviewSnapshotInput,
  request: GitHubGraphqlFetch,
  query: string,
  variables: Record<string, unknown>,
) {
  let response: Response;
  try {
    response = await request('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        'user-agent': 'threadloop-review-sensor',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new Error('GitHub GraphQL review query could not be completed.', { cause: error });
  }
  let value: unknown;
  try {
    value = (await response.json()) as unknown;
  } catch (error) {
    // An error page is often HTML; the status is the useful part of that failure.
    throw new Error(
      response.ok
        ? 'GitHub GraphQL review query returned invalid JSON.'
        : `GitHub GraphQL review query failed: HTTP ${response.status}`,
      { cause: error },
    );
  }
  const result = object(value, 'GitHub GraphQL response');
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (!response.ok || errors.length > 0) {
    const messages = errors.map((entry) => {
      const error = object(entry, 'GitHub GraphQL error');
      return typeof error.message === 'string' ? error.message : 'unknown GraphQL error';
    });
    throw new Error(`GitHub GraphQL review query failed: ${messages.join('; ') || `HTTP ${response.status}`}`);
  }
  const data = object(result.data, 'GitHub GraphQL response.data');
  const repository = object(data.repository, 'GitHub GraphQL repository');
  return object(repository.pullRequest, `GitHub pull request ${input.pullRequestNumber}`);
}

async function paginate(
  label: string,
  readPage: (cursor: string | null) => Promise<{ hasNextPage: boolean; endCursor: string | null }>,
) {
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await readPage(cursor);
    if (!page.hasNextPage) {
      return;
    }
    if (!page.endCursor) {
      throw new Error(`GitHub ${label} pagination omitted its next cursor.`);
    }
    if (seen.has(page.endCursor)) {
      throw new Error(`GitHub ${label} pagination repeated cursor ${page.endCursor}.`);
    }
    seen.add(page.endCursor);
    cursor = page.endCursor;
  }
}

function assertStableMetadata(previous: PullRequestMetadata | null, value: Record<string, unknown>) {
  const current: PullRequestMetadata = {
    number: positiveInteger(value.number, 'GitHub pull request number'),
    url: text(value.url, 'GitHub pull request url'),
    headRefOid: text(value.headRefOid, 'GitHub pull request headRefOid'),
    baseRefName: text(value.baseRefName, 'GitHub pull request baseRefName'),
    merged: boolean(value.merged, 'GitHub pull request merged'),
    mergedAt: nullableText(value.mergedAt, 'GitHub pull request mergedAt'),
    reviewDecision: reviewDecision(value.reviewDecision),
  };
  if (previous && JSON.stringify(previous) !== JSON.stringify(current)) {
    throw new Error('GitHub pull request review state changed while the snapshot was being collected.');
  }
  return current;
}

function pageInfo(value: unknown, label: string) {
  const page = object(value, `${label}.pageInfo`);
  return {
    hasNextPage: boolean(page.hasNextPage, `${label}.pageInfo.hasNextPage`),
    endCursor: nullableText(page.endCursor, `${label}.pageInfo.endCursor`),
  };
}

function parseRepository(repository: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match?.[1] || !match[2]) {
    throw new Error(
      'The GitHub review sensor requires a canonical https://github.com/<owner>/<repo> URL accessible to the workflow token.',
    );
  }
  return { owner: match[1], name: match[2] };
}

function reviewDecision(value: unknown): PullRequestMetadata['reviewDecision'] {
  if (value === null || value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED') {
    return value;
  }
  throw new Error('GitHub pull request reviewDecision is invalid.');
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nullableObject(value: unknown, label: string) {
  return value === null ? null : object(value, label);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function text(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be non-empty text.`);
  }
  return value;
}

function nullableText(value: unknown, label: string) {
  return value === null ? null : text(value, label);
}

function boolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function nullablePositiveInteger(value: unknown, label: string) {
  return value === null ? null : positiveInteger(value, label);
}
