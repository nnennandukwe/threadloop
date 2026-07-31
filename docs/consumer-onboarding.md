# Consumer onboarding

How to enable ThreadLoop in a repository you want it to govern. The steps are ordered because several of them cannot be
done later without discarding work.

Everything here was derived from running a supervised pilot against a real consumer repository. Each prerequisite exists
because skipping it produced a failure that was hard to diagnose from the outside.

## 1. Put the caller workflow on the default branch first

Copy [`examples/threadloop-caller-workflow.yml`](../examples/threadloop-caller-workflow.yml) into the consumer as
`.github/workflows/threadloop.yml`, replace both `@FULL_COMMIT_SHA` pins with one reviewed ThreadLoop commit, and
**commit it to the repository's default branch before starting a governed session**.

The `uses:` slug names the ThreadLoop repository hosting the sensors, not your own, so leave it alone. Change it only if
you consume a fork, and then pin a commit you have reviewed in that fork.

GitHub resolves `workflow_dispatch` targets from the default branch only. A `--ref` chooses which ref gets checked out;
it cannot introduce a workflow that the default branch lacks. Dispatching a caller that exists only on a feature branch
fails with:

```text
HTTP 404: workflow threadloop.yml not found on the default branch
```

The consequence is worth stating plainly: a consumer cannot produce signed evidence for its _first_ governed feature
branch, and the change that enables ThreadLoop cannot itself be governed by signed evidence. Treat enablement as an
ungoverned prerequisite.

## 2. Get the caller workflow right before the first session

The caller workflow lives inside the repository being governed, so editing it changes the governed branch's HEAD. A
changed HEAD makes prior local gate receipts, signed CI receipts, and recorded pre-PR review outcomes stale, because all
of them bind to the HEAD they described.

An in-flight session therefore cannot absorb a caller-workflow fix. It needs a new session. Validate the caller before
starting, not after.

The template covers one trap that is very hard to diagnose. `workflow_dispatch` delivers every input as a string,
including an input declared `type: number`. Passing that string into the review sensor's numeric input fails
`workflow_call` validation **before any job is created**, so there is no failing step and no log to read: the run simply
reports failure with the review job absent. The template casts it:

```yaml
pull_request_number: ${{ fromJSON(inputs.pull_request_number) }}
```

## 3. Make the declared gate self-provisioning

The signed gate sensor runs exactly the command your proof plan declares, on a runner where only Node is set up. It does
not install your language toolchain.

Most repositories' verify targets assume the surrounding CI workflow already provisioned the environment:

```yaml
# typical consumer CI, which ThreadLoop's sensor does not replicate
- uses: astral-sh/setup-uv@v5
- uses: actions/setup-python@v5
- run: uv sync --all-groups
- run: make verify
```

A gate declared as `make verify` against that repository fails in the sensor, because the toolchain is missing. Declare
a gate target that provisions what it needs, and keep it distinct from the developer-facing verify target if that target
assumes a prepared environment.

The proof plan is immutable once bound, so a gate command cannot be corrected mid-session. Getting this wrong means
starting a new session.

## 4. Know where the CLI lives

A runner wake takes exactly four inputs: `repo_root`, `session_id`, `wake_id`, and `mode`. None of them locates the
`threadloop` binary.

That is deliberate: the four inputs carry lifecycle identity and authority, and the CLI's location is environment, not
authority. But it is a real thing an operator must convey, especially when the CLI is installed outside the consumer
repository on purpose so the consumer takes no dependency on it. Whatever delivers a wake must also make the binary
resolvable, by `PATH` or by an absolute path passed as environment.

## 5. Let the projection decide the order, not your plan

`threadloop session next` is authoritative. When a written plan and the live projection disagree about what comes next,
the projection is right.

In the pilot, a plan sequenced local pre-PR reviews before signed CI, while the projection required
`IMPORT_SIGNED_CI_PROOF` before `pre_pr_reviewing` became reachable. Running local reviews first anyway was still the
better operational choice, because signed CI then only ever gets spent on an already-reviewed HEAD, but the ordering the
lifecycle enforces came from the projection.

## `threadloop init` is human-facing

`init` does not accept `--json`, unlike the session, gate, review, and audit commands. This is intentional: `init`
bootstraps and migrates a repository, and it is an operator action rather than part of the agent protocol. The runner
contract explicitly forbids a wake from invoking it, and surfaces
`SESSION_SCHEMA_MIGRATION_REQUIRED -> MIGRATE_SESSION_SCHEMA` as an operator handoff instead.

Scripted setup should treat `init` as a human or operator step and read its exit status rather than parse its output.
