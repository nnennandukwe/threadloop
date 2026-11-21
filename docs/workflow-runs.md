# Graph-bound Workflow Runs

A Workflow Run follows the SDLC graph you give it. ThreadLoop saves that graph when you create the run. You can inspect
it after a restart, ask which action or transition is available, and explicitly apply a transition. The existing session
commands continue to use the fixed PR lifecycle.

## Start a run

Run the commands from an initialized **control repository**. Keep the **subject**, the Git checkout whose changes
ThreadLoop observes, in a separate directory. Start with a clean, named subject branch. The physical observer supports
up to 64 descendants, eight directory levels and 8 KiB per file. It includes ignored files. The subject's root, branch,
revision and physical contents determine whether a previous decision is still current.

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

Save the example profile as `quote.yaml` and the setup as `setup.json`. The first command requires an explicit run ID. A
profile edit takes effect when you create another run. [Shipping quote profile](../tests/fixtures/workflow/quote.yaml)

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

## Enroll governed PR evidence

Use a run ID beginning with `session_wf_` and set the repository ID to its canonical GitHub HTTPS origin. In the setup,
name the v4 proof-plan file, its local and independent gate IDs, the matching proof-binding transition and the paths the
plan allows engineering work to change. The plan enrolls both immutable GitHub Actions signer policies. Set
`trusted_sources` to the path of the source configuration. For example, replace the human node ID in this configuration
with the enrolled reviewer's GitHub User ID.

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

At the current version, prepare an observation before running its sensor. The first review preparation binds the product
PR. The response's `sensor_inputs` contains the exact run, target, plan digest and prepared receipt ID to pass to the
enrolled caller. Pin the caller to a reviewed ThreadLoop revision that supports prepared observations.
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

A `request_stop` instruction carries only its purpose and reason. A `recover_run` instruction names its purpose, the
graph's return transition and a reason. Recovery requires a fresh preparation and approval for the exact suspended
version and recorded prior state.

## Discover the command contract

`threadloop protocol --contract 5 --json` advertises `workflowRun: 1`, the `workflow_runs_v1` capability and each
workflow command. Check the capabilities your client needs. `threadloop protocol --json` and explicit `--contract 4`
return the v4 view consumed by the session runner. Reads and decisions never dispatch an executor.
