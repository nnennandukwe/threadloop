# Workflow Profile and Compiled Graph v0.1

Status: specification and development tooling for [#104](https://github.com/nnennandukwe/threadloop/issues/104). These
contracts do not enable graph execution in the shipped ThreadLoop CLI.

## Published schemas

- [Workflow Profile](schemas/workflow-profile.schema.json) describes the JSON-compatible data authored in YAML.
- [Compiled Graph](schemas/compiled-graph.schema.json) describes the normalized graph and its separate SHA-256 digest.
- [Graph binding](schemas/graph-binding.schema.json) describes the immutable graph identity required by a future run.

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
