# Signed gate receipt v2

ThreadLoop requires two independent kinds of evidence before `verifying -> reviewing`:

1. a current-HEAD local receipt for each declared gate, used to select review or repair; and
2. a verified GitHub Actions receipt for each gate, used only to authorize review.

Signed CI evidence never selects `repairing`. A CI failure remains a GitHub artifact for diagnosis and is not imported
as authoritative passing proof.

## Immutable trust policy

New sessions record proof-plan contract v4. The `ci` object binds the GitHub OIDC issuer, exact caller workflow
identity, source repository, and the commit-pinned ThreadLoop gate workflow. The required sibling `review` policy uses
the same shape and pins `threadloop-review-sensor.yml` independently:

```json
{
  "contract_version": 4,
  "acceptance_criteria": ["All repository checks pass locally and in CI"],
  "ci": {
    "provider": "github-actions",
    "issuer": "https://token.actions.githubusercontent.com",
    "certificate_identity": "https://github.com/OWNER/REPO/.github/workflows/CALLER.yml@refs/heads/BRANCH",
    "source_repository": "https://github.com/OWNER/REPO",
    "build_signer_uri": "https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@FULL_SHA",
    "build_signer_sha": "FULL_SHA"
  },
  "review": {
    "provider": "github-actions",
    "issuer": "https://token.actions.githubusercontent.com",
    "certificate_identity": "https://github.com/OWNER/REPO/.github/workflows/CALLER.yml@refs/heads/BRANCH",
    "source_repository": "https://github.com/OWNER/REPO",
    "build_signer_uri": "https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-review-sensor.yml@FULL_SHA",
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
named branch. Stored v1/v2/v3 plans remain readable and their local gates remain runnable; v1 and v2 cannot authorize
review transitions. Immutable legacy plans are never upgraded in place.

## Reusable workflow

A caller invokes `.github/workflows/threadloop-gate-sensor.yml` by a full ThreadLoop commit SHA. The snippet below
hardcodes its inputs to show the contract. For a caller an operator can actually dispatch, copy
[`examples/threadloop-caller-workflow.yml`](../../examples/threadloop-caller-workflow.yml), which supplies these values
at dispatch time. This workflow runs with only Node set up, so a gate whose command needs a language toolchain declares
it as `setup` steps inside `gate_json`. See [consumer onboarding](../consumer-onboarding.md).

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

The caller must run from a branch ref. The reusable workflow uses two fresh GitHub-hosted jobs:

1. `execute_gate` checks out the caller HEAD and the pinned sensor, runs each declared setup step and then the gate
   command as exact argv without a shell, and observes Git before and after every one of them. This job has only
   `contents: read`; it cannot request an OIDC token and never sees the signed-package output path.
2. `sign_receipt` runs only after `execute_gate` has ended. It receives `id-token: write`, checks out only the pinned
   sensor, downloads the captured report as untrusted data, binds it to the caller inputs and
   `needs.execute_gate.result`, and signs through GitHub OIDC.

The gate subprocess also receives a filtered environment without ThreadLoop control paths, GitHub step-control files, or
GitHub's OIDC request variables. The fresh-runner job boundary is the security boundary: report tampering can never give
the gate process the signing token or final package path. A failed or cancelled execution job is always signed as
nonpassing even if its report claims `passed`.

The workflow uses no keys or repository secrets. A self-contained diagnostic package is uploaded when a captured gate
fails, while the called workflow preserves the failing status. If the report is absent, malformed, oversized, or
context-mismatched, signing fails closed and no package is uploaded.

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
`.threadloop/artifacts/receipts/<session-id>/<receipt-id>/signed-receipt.json`. SQLite schema v7 stores an append-only
verified projection. Identical imports return the existing sequence; a receipt id reused for different content is a
conflict. Import never changes lifecycle state or `state_version`.

`session next --json` rehashes the stored package and revalidates its statement/artifact relationships without making
network calls or repeating Sigstore verification. It reports `policy_missing`, `missing`, `passed`, `stale`, or
`corrupt`. A later commit makes prior local and CI receipts stale.

## Failure boundary

Malformed, oversized, tampered, transparency-free, wrong-identity, wrong-source, wrong-ref, wrong-plan, wrong-gate,
wrong-HEAD, dirty, changed-HEAD, or nonpassing packages create no accepted row and no lifecycle mutation. Sigstore
trust-root or service unavailability fails closed and can be retried later.

## Recorded setup

A v2 artifact records every declared setup step that ran, so the signed receipt continues to describe everything that
happened rather than only the gate command:

```json
{
  "schema_version": 2,
  "result": "setup_failed",
  "setup": [
    {
      "id": "sync",
      "command": ["uv", "sync", "--all-groups", "--frozen"],
      "working_directory": ".",
      "timeout_ms": 600000,
      "result": "failed",
      "started_at": "2026-07-31T11:00:00.000Z",
      "ended_at": "2026-07-31T11:00:41.000Z",
      "duration_ms": 41000,
      "exit_status": 127,
      "signal": null,
      "head_before": "FULL_SHA",
      "head_after": "FULL_SHA",
      "clean_before": true,
      "clean_after": true,
      "output": { "stdout_sha256": "...", "stderr_sha256": "..." }
    }
  ]
}
```

`started_at`, `ended_at`, and `duration_ms` on the artifact span everything that ran, so a gate blocked by failing setup
still reports the real duration of the provisioning that was attempted. `exit_status` and `signal` describe the gate
command and are null when it never ran.

Recorded setup is bound positionally to the gate's declaration: each step's argv, working directory, and timeout must
match the step declared at the same index. A recorded sequence shorter than the declaration is legitimate, because a
failing step stops the run. A recorded step the gate never declared is rejected.

## Version compatibility

|                           | v1                                                  | v2                                                  |
| ------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| Media type                | `application/vnd.threadloop.signed-receipt.v1+json` | `application/vnd.threadloop.signed-receipt.v2+json` |
| Predicate type            | `https://threadloop.dev/attestations/receipt/v1`    | `https://threadloop.dev/attestations/receipt/v2`    |
| `schema_version`          | `1`                                                 | `2`                                                 |
| `sensor.contract_version` | `1`                                                 | `2`                                                 |
| `setup` key               | absent                                              | always present, possibly empty                      |

The four version markers are pinned to each other. A v2 artifact cannot be presented under the v1 media type or
predicate type, and a v1 artifact cannot carry a `setup` key. Newly signed receipts are always v2. Stored v1 packages
remain readable and keep evaluating exactly as before, because signed evidence is re-verified on every read and
invalidating it retroactively would corrupt existing sessions.

## Setup failure is not a code failure

A signed receipt recording `setup_failed` is never imported as authoritative proof, like any other non-passing result.
It is rejected distinctly, as `SIGNED_RECEIPT_SETUP_FAILED`, naming the failing step and its argv, because a missing
toolchain is a configuration problem rather than evidence about the code. The rejection consumes no repair budget and
the signed package remains on disk for diagnosis.
