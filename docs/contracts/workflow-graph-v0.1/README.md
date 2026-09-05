# Workflow Profile and Compiled Graph v0.1

Status: specification and development tooling for [#104](https://github.com/nnennandukwe/threadloop/issues/104). These
contracts do not enable graph execution in the shipped ThreadLoop CLI.

## Published schemas

- [Workflow Profile](schemas/workflow-profile.schema.json) describes the JSON-compatible data authored in YAML.
- [Compiled Graph](schemas/compiled-graph.schema.json) describes the normalized graph and its separate SHA-256 digest.
- [Graph binding](schemas/graph-binding.schema.json) describes the immutable graph identity required by a future run.
- [Capability catalog](capabilities.md) defines the meaning of every registered guard and action.

Strict Zod definitions in the development tooling produce Draft 2020-12 JSON schemas. Tests compare the checked-in
schemas to those definitions and validate them with Ajv. Schema identifiers are stable identifiers, not network
dependencies; validation uses local documents only. Cross-reference, topology, authority, and canonicalization checks
are additional compilation requirements beyond JSON Schema shape validation.

## Authoring boundary

Use one YAML 1.2 document and quote `schema_version: "0.1"`. Mapping keys must be strings. Duplicate keys, aliases,
anchors, merge keys, explicit tags, unknown fields, non-finite numbers, and non-integer or unsafe numeric values are
rejected. Identifiers begin with a lowercase ASCII letter and contain at most 64 lowercase letters, digits, or
underscores. Profile revisions are positive safe integers; they identify author revisions, not schema compatibility.

Guard parameters are discriminated by a closed capability name. Required Actions identify a capability and actor; their
parameter objects are currently empty. They are not executable Action Requests. Profiles cannot introduce executable
code, shell commands, expression languages, provider payloads, or dynamically loaded capabilities.

## Verification

From the repository root, run `npm test -- tests/unit/workflow-graph-contract.test.ts` for focused iteration and
`npm run check` before review. These checks do not rewrite the published schemas or fixture expectations.

## Compilation and graph identity

The development-only `compileWorkflowProfile(source)` function returns either
`{ ok: true, value: { graph, graph_digest } }` or `{ ok: false, diagnostics }`. It performs no filesystem, clock,
environment, network, capability execution, or runtime-state reads. Callers supply YAML text explicitly. Diagnostics
contain a stable code, a document path, an implicated identifier when available, a message, and recovery guidance. Shape
errors precede semantic checks; no invalid input receives a graph or digest.

Compilation resolves references, checks reachability and terminal paths, verifies authority requirements, validates
cycle controls, then normalizes the profile. A JSON Schema-valid document alone is not an accepted graph.

Normalization discards only the optional root author `description`. It retains profile identity and revision, schema
version, and the immutable capability catalog identity `threadloop.sdlc/0.1`. Declaration arrays sort by ASCII `id`;
reference and authority arrays sort lexicographically. Duplicate identifiers within each declaration namespace and
duplicate references are rejected. Multiple outgoing edges need explicit distinct priorities; a sole edge defaults to
priority zero. Omitted guard `required_actions`, budgets, and cycle controls become empty arrays. An omitted phase
policy becomes `null`. Compiled graphs contain every normalized field and reject author descriptions.

Canonical JSON recursively sorts object keys by UTF-16 code units, preserves normalized array order, uses ECMAScript
JSON string escaping, and contains no insignificant whitespace or trailing newline. Encode those characters as UTF-8 and
hash them with SHA-256. The resulting 64 lowercase hexadecimal characters are stored in `graph_digest`, outside the
hashed `graph` payload. Strings are preserved without Unicode normalization; numbers are safe integers serialized as
JSON integers, including negative zero as zero. This defines ThreadLoop's algorithm; it does not claim RFC 8785
conformance.

Each valid fixture has a readable `.compiled.json` envelope, a `.canonical` file containing the exact JSON payload bytes
without a trailing newline, and a `.binding.json` identity. These are reviewed golden expectations. Tests neither update
them nor infer expected digests from current compiler output.

The development-only `validateGraphBinding(binding, compiled)` helper validates both schemas, graph semantics, canonical
declaration order, the claimed graph digest, and equality with the supplied binding. It returns the validated graph or
diagnostics and never changes its inputs. It accepts JSON values, not serialized bytes; insignificant JSON whitespace or
object-key presentation is outside this helper's input. A future byte-oriented importer must verify the canonical byte
contract as well.

## Transition and cycle semantics

Every transition requires ThreadLoop authority. All referenced guards and authority requirements are conjunctive. A
guard may identify Required Actions that could supply its missing evidence; declaring those actions never satisfies the
guard. Lower integer priorities take precedence among eligible transitions. No eligible edge means no transition
permission; the Controller Decision representation belongs to
[#105](https://github.com/nnennandukwe/threadloop/issues/105). The compiler does not evaluate guards or select a next
action.

Human approval guards also require human authority. Terminal entry requires current-subject human approval and observed
merge or publication; terminal states have no outgoing edges. Suspended states require a human `recover_run` handoff and
explicit block evidence on entry. Every recovery edge requires recovery approval and a `recorded_prior_state` guard
whose target matches that edge. Recovery cannot reset budgets or phase history.

A run starts in an active state; suspension and completion require guarded transitions. Recovery targets an active prior
state, never another suspension or terminal state. Every state must be reachable from the initial state and have a
structural terminal path. This is a topology guarantee, not a promise that evidence will arrive or that opaque guards
eventually pass.

Cycle controls have four closed forms:

| Kind             | Required structural proof                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `budget`         | Every listed budget entry checks `budget_available` for that counter. Each entry source has an explicit exit to suspension or completion that requires no budget availability. |
| `human_escape`   | Every named state has an explicit edge into human suspension.                                                                                                                  |
| `terminal_route` | The listed exit edges form an acyclic subgraph through which each named state reaches a terminal state.                                                                        |
| `guard_stop`     | Each listed exit reaches suspension or completion and requires the named registered `stop_requested` guard.                                                                    |

For residual-cycle analysis, remove counted edges certified by valid budget controls, edges requiring human authority on
every traversal, and states certified by a valid escape or stop route. Any remaining directed cycle is rejected.
Controls do not certify an entire strongly connected component: an inner self-loop or overlapping cycle that avoids the
control still fails. Escape and terminal-route declarations establish an available intervention route, not automatic
eventual termination. Guard truth, budget accounting, and actual human authority must be enforced by a future runtime.

Budget consumption counts accepted transitions with the listed identifiers across the full run history. Entry is allowed
only when the count is strictly below `limit`; the accepted entry consumes one unit. Rejected attempts and idempotent
replays add none. The final permitted entry may finish its work and return through verification. Exhaustion denies a new
entry and leaves the declared exit available; it neither invents block evidence nor silently changes state.

## Compatibility and run binding

Only the string schema version `"0.1"` and catalog identity `threadloop.sdlc/0.1` are supported. Unknown fields,
capability names, versions, and provider payload types fail closed. Ordinary prose may name a provider;
provider-specific guard, action, authority, or parameter types do not become core capabilities.

An additive future version preserves all existing field meanings and canonicalization rules while introducing explicitly
negotiated fields or capabilities. Removing or reinterpreting a field, changing authority or guard semantics, or
changing canonical bytes is breaking. Neither kind is implicitly accepted by this v0.1 reader. Support needs an explicit
schema and catalog update with reviewed compatibility fixtures; unknown data is never dropped before hashing.

A future Workflow Run must retain its original `graph_schema_version` and `graph_digest` for its lifetime. Editing a
YAML profile may create a new graph artifact, but cannot replace the graph bound to an active run. An unavailable old
graph requires restoration or explicit blocking, not substitution. These are contract requirements and specification
tests; existing sessions do not acquire graph bindings from this issue.

Graph identity is separate from database schema capabilities and current protocol versions. Existing SQLite schema v8
records, receipts, and audit history keep their meaning. [#85](https://github.com/nnennandukwe/threadloop/issues/85)
owns storage evolution; [#86](https://github.com/nnennandukwe/threadloop/issues/86) owns persisted run/configuration
identity. No storage migration, graph interpreter, scheduler, or Rust runtime is introduced here.

## Example profiles and preservation evidence

The [governed PR profile](fixtures/valid/governed-pr.yaml) maps the current default lifecycle inspected at
`134b9a58c652a05fd9e6fa5181d96b5d248a4cc1`. Its lifecycle, proof, and review sources are unchanged from the baseline
inspected by the [current lifecycle mapping](../../current-lifecycle-graph-mapping.md). All eleven states and every
ordinary forward edge are checked against current exported domain definitions. Tests additionally pin the guard
requirements, current subject requirements, phase policy, counted repair entries, and block/recovery edges.

The pre-PR profile may repeat implementation, verification, and pre-PR review indefinitely with an explicit human
escape. After review entry, failures use the three-entry repair budget. Counting includes historical legacy entries even
if their derived phase is `pre_pr`. `setup_failed` requests setup correction, not repair. The third repair may finish
verification and return to review; the fourth new repair entry is denied. Completion requires both same-subject human
approval and observed merge.

The [preservation manifest](preservation.json) maps every preservation-checklist item to graph declarations, capability
requirements, or an explicit future-runtime obligation. It also maps every current `required_work` code and receipt
family. Tests check references and compare required-work coverage to the existing mapping. A single Required Action is a
capability mapping, not a complete sequence: `REFRESH_REVIEW_PROOF_SET`, for example, also requires local and
independent proof as described by `review_set`. Legacy `IMPLEMENT_ISSUE_40` means restoring proof authority, not
executing an issue-number action.

Atomic state/version checks, exact replay, append-only audit integrity, current storage compatibility, and adapter trust
validation are retained as mandatory runtime obligations. They are not proven by compiling a YAML file. Their executable
controller conformance belongs to [#108](https://github.com/nnennandukwe/threadloop/issues/108). Workflow
`main`/`origin` defaults and one task per checkout remain caller/profile policy; proof-plan `baselineBranch` remains the
bound working branch. Existing sessions are not retroactively converted to graph runs.

The [release-to-publish profile](fixtures/valid/release-to-publish.yaml) has a distinct artifact-based lifecycle:
preparation, release verification, human approval, publication, publication verification, and completion. Failed release
or publication verification can return to preparation twice, with an explicit human escape when work must stop. Artifact
changes invalidate prior approval. This fixture has no PR phase policy or PR review capabilities and is
specification-only; it does not publish anything.

The [minimal release vector](fixtures/valid/minimal-release.yaml) provides a small independently inspectable
canonicalization example. All three profiles, their bindings, and the [invalid corpus](fixtures/invalid/expected.json)
are checked by the normal verification workflow.
