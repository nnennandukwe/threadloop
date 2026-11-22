# Graph-bound Workflow Runs

A Workflow Run follows the SDLC graph you give it. ThreadLoop saves that graph when you create the run. You can inspect
it after a restart, ask which action or transition is available, and explicitly apply a transition. The existing session
commands continue to use the fixed PR lifecycle.

## Start a run

Run the commands from an initialized **control repository**. Keep the **subject**, the Git checkout whose changes
ThreadLoop observes, in a separate directory. Start with a clean, named subject branch that has an initial commit. The
physical observer supports up to 64 descendants, eight directory levels and 8 KiB per file. It includes ignored files.
The subject's root, branch, revision and physical contents determine whether a previous decision is still current.

Create a workflow setup JSON file. The setup and any referenced source files are adopted at creation. Relative paths in
the setup resolve from its directory. This example uses a local graph with a guard-free first transition.

```json
{
  "schema_version": "threadloop.workflow-setup/1",
  "subject_workspace": "../subject",
  "repository_id": "shipping",
  "policy": {
    "id": "quote",
    "proof_binding_transition_id": null,
    "local_gate_ids": [],
    "independent_gate_ids": [],
    "publication_destination": null
  },
  "proof_plan": null,
  "trusted_sources": null,
  "allowed_change_paths": []
}
```

Save the example profile as `quote.yaml` and the setup as `setup.json`. Choose a run ID when you call `workflow create`.
A profile edit takes effect when you create another run. [Shipping quote profile](../tests/fixtures/workflow/quote.yaml)

```sh
threadloop init
threadloop workflow create shipping-quote --profile quote.yaml --setup setup.json --json
threadloop workflow inspect shipping-quote
threadloop workflow decide shipping-quote --json > decision.json
threadloop workflow apply shipping-quote --decision decision.json --idempotency-key start-quote --json
```

The quote starts at `intake`, version 0. Applying `start_quote` moves it to `prepared`, version 1. Retrying the same
decision with the same key returns the committed response. A new decision needs a new key. If the subject, evidence or
state changes, collect a fresh decision. `inspect` can read the verified graph and run history while the subject is
offline. `decide` reports blocked, waiting and human handoff outcomes in ordinary successful JSON responses.

ThreadLoop reads up to 1 MiB per profile, setup, proof plan or source configuration, 4 MiB per decision and 32 KiB per
instruction. Each signed receipt package can use up to 10 MiB. Keep the original package bytes for an exact retry.

## Enroll governed PR evidence

Use a run ID beginning with `session_wf_` and set the repository ID to its canonical GitHub HTTPS origin. In the setup,
name the v4 proof-plan file, its local and independent gate IDs, the matching proof-binding transition and the paths the
plan allows engineering work to change. The plan enrolls both immutable GitHub Actions signer policies. Set
`ci.certificate_identity` to the gate caller on the subject branch. For a run that accepts stop or recovery
instructions, pin `review.certificate_identity` to the review caller on the enrolled base branch. Changing either signer
requires a new run. Set `trusted_sources` to the path of the source configuration. For example, replace the human node
ID in this configuration with the enrolled reviewer's GitHub User ID.

```json
{
  "schema_version": "threadloop.workflow-sources/1",
  "host_producers": [],
  "github": {
    "base_ref": "main",
    "human_node_id": "REPLACE_WITH_GITHUB_USER_NODE_ID",
    "preparation_ttl_ms": 300000,
    "evidence_ttl_ms": 900000
  }
}
```

The two lifetimes are positive whole milliseconds. Each deadline must fit a four-digit UTC year. Prepare an observation
before running its sensor. The first review preparation binds the product PR. The response's `sensor_inputs` contains
the exact run, target, plan digest and prepared receipt ID to pass to the enrolled caller. Pin the caller to a reviewed
ThreadLoop revision that supports prepared observations.
[Reusable caller template](../examples/threadloop-caller-workflow.yml)

```sh
threadloop workflow evidence prepare signed-gate --run session_wf_shipping --gate check \
  --expected-state-version 3 --idempotency-key check-1 --json
threadloop workflow evidence prepare signed-review --run session_wf_shipping --pr 42 \
  --expected-state-version 3 --idempotency-key review-1 --json
threadloop workflow evidence import signed-review --run session_wf_shipping --source review-package.json \
  --expected-state-version 3 --json
```

Use `signed-gate` to import a gate package. Import checks the signature, caller and preparation, observes the subject,
and retains the exact bytes. It increments the evidence revision. A preparation created at version 3 can supply evidence
at version 4 on the same clean subject. Pass the current version to import. A later signed snapshot can withdraw an
earlier approval. Completion requires the enrolled human's current approval and the observed completion at the same
head. Repeating an import returns the original acceptance. It can't renew expired authority.

## Authorize a stop or recovery

Use a separate authorization PR against the enrolled base. Before collection, prepare a `signed-instruction` with the PR
number and an instruction JSON file. For example, on the governed PR graph, this instruction authorizes suspension while
the run is at `queued`.

```json
{
  "purpose": "block_run",
  "transition_id": "block_queued",
  "reason": "The required input is missing.",
  "stop_code": "missing_input",
  "evidence_ref": "issue-7",
  "recovery": "Review the replacement input.",
  "request_stop": true
}
```

```sh
threadloop workflow evidence prepare signed-instruction --run session_wf_shipping --pr 7 \
  --instruction block.json --expected-state-version 0 --idempotency-key missing-input --json
```

Write the exact UTF-8 bytes of `data.manifest_json` to `.threadloop-instruction.json` at the authorization branch root,
without a trailing newline. That file must be the branch's only change from the sensor's authenticated base commit. The
enrolled human reviews the commit. Make its Git objects available in the subject repository while keeping the product
branch checked out. Collect the prepared review with the enrolled caller from the base branch and import its package as
`signed-instruction`. Ask for a fresh decision and apply the selected suspension edge.

Keep the companion branch close to the authenticated base. ThreadLoop reads up to 70 Git objects, 128 KiB per object and
2 MiB in total to verify the commit, ancestry, trees and instruction bytes.

A `request_stop` instruction carries only its purpose and reason. A `recover_run` instruction names its purpose, the
graph's return transition and a reason. Recovery requires a fresh preparation and approval for the exact suspended
version and recorded prior state.

## Discover the command contract

`threadloop protocol --contract 5 --json` advertises `workflowRun: 1`, the `workflow_runs_v1` capability and each
workflow command. Check the capabilities your client needs. `threadloop protocol --json` and explicit `--contract 4`
return the v4 view consumed by the session runner. Reads and decisions never dispatch an executor.

The packaged CLI at `fbfdf8a04755fab3e361f8365ce10a665dfd2b86` passed the create, decide, apply and reopen smoke check.
The previous CLI at `0694d0c50143aa4dd2799586456aa5a18008514f` returned identical v4 text and JSON on Node 22.23.2,
24.20.0 and 26.8.2. Both versions read the same legacy audit exports. An older session writer could commit a transition
while the graph-bound run retained its original state.
[Compatibility checks](plans/issue-170-durable-workflow-runs.md#verification-at-the-implementation-checkpoint)

## Execute a selected engineering action

Create the run with `schema_version` set to `threadloop.workflow-setup/2` and `gaap` set to
`{"adapter":"adapter.json","host":"host.json"}`. Keep the other setup fields from the example above. The
`threadloop.gaap-host/1` file identifies the absolute executable, its invocation, the subject workspace, verification
keys and limits. The host and its private environment belong outside the subject. ThreadLoop measures the executable and
each regular file named by an absolute argument or environment value. On Linux and macOS, your account or root must own
each file and protect its path from other writers. A private installation can sit under a sticky system temporary
directory. ThreadLoop checks these permissions and digests at enrollment and again before starting the host. The
`threadloop.workflow-gaap-adapter/1` file supplies the frozen `mapping_policy`, executor `parameters`, `executor`
identity and `lease_ms`. Its `execution_policy` has an `id`, `retry_safety` and `max_attempts`. Enroll a mapping for an
executor capability the graph declares. Check that its required evidence families cover the action's guards. The
existing native proof shows how to construct these files for the governed profile.
[Executor formats and limits](gaap-executor.md)

Save the decision in the control repository. A managed run derives its Action Request from current evidence and checks
it again when the Attempt starts. A selected human action returns its handoff.

```bash
threadloop workflow decide shipping --json > decision.json
threadloop workflow execute shipping --decision decision.json --json > execution.json
threadloop workflow inspect shipping --json
```

A successful execute records the authenticated child admission in the outer execution history. Its JSON result includes
`data.correlation`. Save that object as `correlation.json`. After a lost response, the inspector also exposes
`data.execution.correlation`. For a reservation that hasn't enrolled yet, retry the original execute. For a started
Attempt, inspect its child and import its evidence. The inspector counts durable start records. A crash between the
start commit and process creation can leave one start and zero invocations. The import can verify an observed result or
recover a committed receipt, including after the original output directory disappeared. A start without a confirmed
outcome remains held for reconciliation.

```bash
threadloop workflow evidence import gaap --run shipping --source correlation.json --expected-state-version 3 --json
threadloop workflow decide shipping --json
```

If an enrolled claim has passed its deadline, inspect the run for its Attempt ID and current state version. When
inspection recommends `expire-claim`, copy its `recovery_argv`. For example, if the state version is 3:

```bash
threadloop workflow expire-claim shipping --attempt "$attempt_id" --expected-state-version 3 --json
```

ThreadLoop records the expired claim and its Attempt status. A started Attempt retains its unknown effect. Preserve its
transport evidence for independent verification of the stop and effect, followed by the human disposition required by
the bound policy. A pending Attempt records that execution never started. Inspect its retry policy and remaining Attempt
budget. An admission that committed while the claim was valid can still be imported after expiry. Clients can discover
the expiry command through protocol v5 capability `workflow_claim_expiry_v1`.

The lifecycle advances when you deliberately apply a fresh transition. If the action changed the workspace, the next
guard can require a scoped commit or independent proof. Use the run's current state version in each request. Keep both
the outer state database and its owned child directories when backing up or restoring a managed run.

## Collect gate or pre-PR review evidence

For a local gate, use the ID from the immutable proof plan. ThreadLoop captures the gate's actual outputs in the control
repository and admits them for its observed subject. If the CLI stops, run
`threadloop workflow inspect shipping --json`. The `collections` list identifies the key and attempt. For a `reserved`
gate, repeat the original request. One delivery can claim the launch. For a `captured` gate, the same request admits the
result from the database even if its output directory is gone. A completed request returns its recorded reply.

A `launch_claimed` gate with no captured result holds the run. The process may already have changed the subject. Inspect
its retained output and independently reconcile any effect before taking further action. An older interrupted gate
without a launch record also has an unknown outcome. Creating a new key can't authorize another launch.

```bash
threadloop workflow evidence collect local-gate --run shipping --gate check --expected-state-version 4 --idempotency-key verify-local
```

To collect a Qodo review, declare `pre-pr-review` in `host_producers` and enroll a `review_reader` in setup/2. Set its
`provider` to `qodo` and supply the trusted status reader's absolute `executable`, an immutable `base_commit` and a
`reviewer_id`. Omit both the review source and its reader when the run won't collect reviews. Setup/1 retains its
existing host-produced review policy. An earlier setup/2 run that declared the source without a reader retains its
original policy, which can't admit pre-PR review evidence. Start a new run to enroll a reader. Preserve the operation ID
when submitting the authorized full review of the subject.

Install the reader on Linux or macOS under its real path. Your account or root must own the executable and each
directory on its path. Other accounts mustn't have write access. A private installation directory can sit under a sticky
system temporary directory. ThreadLoop runs the measured executable in place so the Qodo launcher can find its package
files. The host account is responsible for protecting the launcher's interpreter and dependencies. ThreadLoop checks the
reader's digest and permissions before starting it and again before accepting its output.

```bash
threadloop workflow evidence collect pre-pr-review --run shipping --operation "$operation_id" --expected-state-version 5 --idempotency-key collect-review
```

If the Qodo operation is still working, repeat the original request with the same operation and key after it finishes.
The collector reads that operation's terminal result. It checks the base, current commit and Git tree, primary review,
coverage and active finding inventory. Previously open findings can still block the run. Independent CI, human approval
and merge observations use their signed sources. Request protocol 5 and check `workflow_gaap_execution_v1` before
calling managed execution commands.
