# Signed gate receipt v1

ThreadLoop requires two independent kinds of evidence before `verifying -> reviewing`:

1. a current-HEAD local receipt for each declared gate, used to select review or repair; and
2. a verified GitHub Actions receipt for each gate, used only to authorize review.

Signed CI evidence never selects `repairing`. A CI failure remains a GitHub artifact for diagnosis and is not imported
as authoritative passing proof.

## Immutable trust policy

New sessions record proof-plan contract v2. The `ci` object binds the GitHub OIDC issuer, exact caller workflow
identity, source repository, and the commit-pinned ThreadLoop reusable workflow:

```json
{
  "contract_version": 2,
  "acceptance_criteria": ["All repository checks pass locally and in CI"],
  "ci": {
    "provider": "github-actions",
    "issuer": "https://token.actions.githubusercontent.com",
    "certificate_identity": "https://github.com/OWNER/REPO/.github/workflows/CALLER.yml@refs/heads/BRANCH",
    "source_repository": "https://github.com/OWNER/REPO",
    "build_signer_uri": "https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@FULL_SHA",
    "build_signer_sha": "FULL_SHA"
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

The source repository must match the checkout's GitHub `origin`, and the caller workflow identity must bind the current
named branch. Stored legacy plans remain readable and their local gates remain runnable, but `session next --json`
reports `ci_proof.status: "policy_missing"`. Immutable legacy plans are never upgraded in place.

## Reusable workflow

A caller invokes `.github/workflows/threadloop-gate-sensor.yml` by a full ThreadLoop commit SHA:

```yaml
permissions:
  contents: read

jobs:
  check:
    permissions:
      contents: read
      id-token: write
    uses: nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@FULL_COMMIT_SHA
    with:
      session_id: session_123
      plan_sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      gate_id: check
      gate_json: '{"command":["npm","run","check"],"id":"check","timeout_ms":900000,"working_directory":"."}'
```

The caller must run from a branch ref. The reusable workflow checks out both the caller HEAD and its own source, runs
the exact argv without a shell, observes Git before and after execution, signs through GitHub OIDC, and uploads one
self-contained package. It uses no keys or repository secrets. The package is uploaded even when the gate fails, while
the called job preserves the failing status.

## Package and statement

The package media type is `application/vnd.threadloop.signed-receipt.v1+json`. Its `artifact` records the exact gate,
result, timestamps, output digests, clean/HEAD observations, GitHub source/run identity, runner identity, and sensor
contract. Its Sigstore bundle carries a DSSE payload of type `application/vnd.in-toto+json`.

The payload is an in-toto Statement v1 with exactly two subjects:

- the source repository and its `gitCommit` digest; and
- `threadloop-gate-receipt.json` and the SHA-256 digest of the canonical artifact.

The predicate type is `https://threadloop.dev/attestations/receipt/v1`. Predicate receipt type `gate` is the only type
accepted in this version.

## Verification and import

```bash
threadloop session gate import ./signed-receipt.json \
  --session "$SESSION_ID" \
  --json
```

The command accepts no issuer, identity, repository, workflow, or trust-root override. Input is limited to 10 MiB.
Before appending evidence, ThreadLoop verifies:

- Sigstore signature validity with `sigstore@4.1.1`;
- Fulcio certificate transparency and a Rekor inclusion proof;
- the GitHub issuer and exact reusable-workflow certificate identity;
- `job_workflow_ref` and `job_workflow_sha` through the build-signer certificate extensions;
- the separate caller workflow identity and caller workflow digest certificate extensions;
- GitHub-hosted runner, source repository, source ref, source HEAD, and run invocation URI;
- exact Statement, predicate, artifact, session, plan, and gate relationships; and
- a clean, unchanged, passing result for the checkout's current HEAD.

Accepted packages are canonicalized under
`.threadloop/artifacts/receipts/<session-id>/<receipt-id>/signed-receipt.json`. SQLite schema v5 stores an append-only
verified projection. Identical imports return the existing sequence; a receipt id reused for different content is a
conflict. Import never changes lifecycle state or `state_version`.

`session next --json` rehashes the stored package and revalidates its statement/artifact relationships without making
network calls or repeating Sigstore verification. It reports `policy_missing`, `missing`, `passed`, `stale`, or
`corrupt`. A later commit makes prior local and CI receipts stale.

## Failure boundary

Malformed, oversized, tampered, transparency-free, wrong-identity, wrong-source, wrong-ref, wrong-plan, wrong-gate,
wrong-HEAD, dirty, changed-HEAD, or nonpassing packages create no accepted row and no lifecycle mutation. Sigstore
trust-root or service unavailability fails closed and can be retried later.
