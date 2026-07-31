# Signed review receipt v1

ThreadLoop imports a provider-neutral review snapshot signed by a commit-pinned GitHub Actions workflow. GitHub collects
the evidence, Sigstore establishes its origin, and ThreadLoop applies lifecycle policy only after local verification.
Neither the collector nor telemetry decides lifecycle state.

## Trust policy

New proof plans use contract v3 and define review trust independently from CI:

```json
{
  "contract_version": 3,
  "acceptance_criteria": ["Current review evidence has no blockers"],
  "ci": {
    "provider": "github-actions",
    "issuer": "https://token.actions.githubusercontent.com",
    "certificate_identity": "https://github.com/OWNER/REPO/.github/workflows/CALLER.yml@refs/heads/BRANCH",
    "source_repository": "https://github.com/OWNER/REPO",
    "build_signer_uri": "https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@GATE_SHA",
    "build_signer_sha": "GATE_SHA"
  },
  "review": {
    "provider": "github-actions",
    "issuer": "https://token.actions.githubusercontent.com",
    "certificate_identity": "https://github.com/OWNER/REPO/.github/workflows/CALLER.yml@refs/heads/BRANCH",
    "source_repository": "https://github.com/OWNER/REPO",
    "build_signer_uri": "https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-review-sensor.yml@REVIEW_SHA",
    "build_signer_sha": "REVIEW_SHA"
  },
  "gates": [
    {
      "id": "check",
      "command": ["npm", "run", "check"],
      "working_directory": ".",
      "timeout_ms": 900000
    }
  ]
}
```

The source repository must match the checkout's GitHub origin. The caller certificate identity must bind the named task
branch. The pinned review signer URI and SHA must identify the reusable review workflow.

## Reusable workflow

A caller invokes `.github/workflows/threadloop-review-sensor.yml` by a full ThreadLoop commit SHA. The snippet below
hardcodes its inputs to show the contract. For a caller an operator can actually dispatch, copy
[`examples/threadloop-caller-workflow.yml`](../../examples/threadloop-caller-workflow.yml), which supplies these values
at dispatch time and casts the numeric input as `workflow_dispatch` requires. See
[consumer onboarding](../consumer-onboarding.md).

```yaml
permissions:
  contents: read

jobs:
  review:
    uses: nnennandukwe/threadloop/.github/workflows/threadloop-review-sensor.yml@FULL_COMMIT_SHA
    with:
      session_id: session_123
      plan_sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      pull_request_number: 42
    permissions:
      contents: read
      pull-requests: read
      id-token: write
```

The reusable workflow separates collection from signing:

1. `collect_review` has `contents: read` and `pull-requests: read`, but no OIDC permission. It paginates reviews and
   review threads, records their root comments, and emits a normalized snapshot. GraphQL errors, cursor loops, partial
   pagination, metadata drift, or rate-limit exhaustion fail the job before signing.
2. `sign_receipt` has `contents: read` and `id-token: write`, but no pull-request API access. It treats the downloaded
   snapshot as untrusted, revalidates it against the workflow inputs and trusted GitHub context, then signs it.

The workflow invocation SHA and reviewed pull-request HEAD are different fields. The in-toto subject binds the reviewed
HEAD. Sigstore certificate fields bind the trusted workflow invocation.

## Artifact and package

The canonical artifact records:

- receipt, session, and proof-plan identity;
- pull-request number, URL, reviewed HEAD, base ref, merge status, and merge time;
- `review.decision`, which carries the aggregate review state, and `review.approvals`, which contains only submitted
  reviews whose state is `APPROVED`;
- review-thread root identity, resolution, outdated status, and author;
- observation time; and
- sensor repository, ref, invocation SHA, run URL, and contract version.

The signed package media type is `application/vnd.threadloop.signed-review-receipt.v1+json`. Its DSSE payload is an
in-toto Statement v1 whose first subject binds the reviewed pull-request HEAD and whose second subject binds the
canonical review artifact digest.

## Verification and import

The signing job uploads `threadloop-signed-review-<pull-request-number>-<run-attempt>` for 30 days. In the Actions UI,
open the caller workflow run, download that exact artifact from **Artifacts**, and extract `signed-review-receipt.json`.
The same retrieval with the GitHub CLI is:

```bash
gh run download <run-id> \
  --name "threadloop-signed-review-<pull-request-number>-<run-attempt>" \
  --dir ./threadloop-review-receipt
```

The run URL identifies `<run-id>`, and the run summary shows the attempt number (`1` for the initial attempt). Import
the extracted file:

```bash
threadloop session review import ./threadloop-review-receipt/signed-review-receipt.json \
  --session "$SESSION_ID" \
  --json
```

The command accepts no trust override and limits input to 10 MiB. Before persistence it verifies:

- valid JSON, exact package and artifact structure, and canonical hashes;
- Sigstore signature, certificate transparency, and Rekor inclusion;
- issuer, signer URI/SHA, caller identity, repository, ref, and workflow invocation;
- in-toto subjects and predicate;
- session id, proof-plan digest, source repository, pull request, and current checked-out HEAD; and
- agreement between the package, statement, artifact, and immutable v3 review policy.

Only after verification does ThreadLoop promote the canonical package to
`.threadloop/artifacts/receipts/<session-id>/<receipt-id>/signed-review-receipt.json` and append its immutable database
projection and audit event transactionally. Identical imports are idempotent. Reusing a receipt id for different bytes
is a conflict. Concurrent identical imports produce one row and one event.

## Lifecycle policy

The latest valid imported receipt is authoritative:

- `CHANGES_REQUESTED` or any unresolved, non-outdated thread selects `repairing`;
- a blocker-free current snapshot selects `ready_for_human`;
- a later blocker can return `ready_for_human` to `repairing`; and
- completion requires the current snapshot to observe both the merged PR and at least one same-HEAD approval from actor
  type `User`.

Bot approvals and approvals for another HEAD do not satisfy completion. Review and gate repairs share the same
three-cycle budget. Import itself never changes lifecycle state.

## Failure boundary

Malformed, oversized, unsigned, transparency-free, wrong-identity, wrong-repository, wrong-plan, stale-HEAD, or
internally inconsistent packages create no database row, final package, audit event, or lifecycle mutation. A corrupt
controlled package causes later projections and transitions to fail closed until authoritative evidence is restored.
