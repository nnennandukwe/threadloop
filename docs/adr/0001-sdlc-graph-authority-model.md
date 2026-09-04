# SDLC Graph Authority Model

Status: accepted

ThreadLoop owns the outer proof-carrying SDLC graph for a Workflow Run. Agent harnesses, conformance systems, executors,
and delivery infrastructure can provide evidence or perform bounded actions, but they do not choose ThreadLoop's next
Lifecycle State or complete the Workflow Run.

## Context

ThreadLoop already models a governed software-delivery lifecycle with explicit states, guarded transitions, proof,
review evidence, blocking, repair, and human completion. The project needs one stable vocabulary before configurable
workflow contracts, execution-claim machinery, or a Rust implementation are introduced. Infrastructure language must not
leak into the public SDLC model.

The overloaded word "loop" has three meanings that must stay separate:

- A Model/Tool Loop is the inner reasoning and tool-use cycle inside one Agent Run.
- An Agent Run is a bounded harness execution, such as a GAAP-governed run.
- The Outer SDLC Feedback Loop is ThreadLoop's evidence-bound software-delivery cycle.

## Decision

ThreadLoop is the authority for the outer Workflow Run. It owns the SDLC graph, durable workflow state, action
selection, execution-claim semantics, evidence freshness, guarded advancement, blocking, recovery, and human completion
boundaries.

GAAP or another compatible harness owns one inner Agent Run and the protected effects within that run. GAAP completion
is evidence for ThreadLoop; it is not Workflow Run completion.

RunInvariant evaluates conformance and never advances ThreadLoop runtime state.

Executors perform an Action Request. They do not choose the next Lifecycle State, approve transitions, recover blocked
runs, or complete a Workflow Run.

Delivery infrastructure may deliver or wake an executor. It cannot invent Action Requests, authorize Transitions,
recover blocked runs, approve merges, or complete a Workflow Run.

## Considered Options

- Let the harness own the whole lifecycle. Rejected because protected-effect governance inside one Agent Run is not the
  same authority as software-delivery lifecycle advancement.
- Let delivery infrastructure own retries and completion. Rejected because duplicate delivery, scheduling, and wake
  mechanics cannot determine evidence freshness or human approval.
- Let conformance tests advance runtime state. Rejected because conformance evaluation should be independent evidence,
  not a state mutation channel.
- Keep ThreadLoop as outer authority and accept evidence from other systems. Chosen because it preserves explicit
  lifecycle decisions while allowing compatible harnesses, executors, and conformance systems to integrate through
  evidence.

## Consequences

- ThreadLoop's public language centers on Workflow Profile, Compiled Graph, Workflow Run, Lifecycle State, Transition,
  Guard, Required Action, Action Request, Execution Claim, Attempt, Evidence Receipt, and Authority Boundary.
- ThreadLoop documentation must distinguish Workflow Run from Agent Run and must not describe GAAP completion as
  ThreadLoop completion.
- Public SDLC language should avoid "work order" and "lease"; those words may describe private implementation mechanisms
  only if a later design explicitly introduces them.
- Existing CLI and storage names are compatibility terms for now. This ADR does not rename commands, types, database
  fields, runner inputs, lifecycle states, or protocol output.
- Configurable graphs, execution claims, GAAP runtime ingestion, RunInvariant integration, and a Rust runtime remain
  future work unless a later issue implements them.

## Scenarios

**Duplicate delivery**: Delivery infrastructure may deliver the same wake more than once. ThreadLoop must treat delivery
as transport only; an executor may act only from an existing Action Request and any duplicate must preserve the original
authority boundary.

**Stale evidence**: An Evidence Receipt for an older repository head cannot advance the current Workflow Run. ThreadLoop
must require fresh evidence for the head being evaluated before the relevant Guard can pass.

**GAAP reporting completion**: GAAP may report that one Agent Run completed. ThreadLoop may accept that as evidence
about the bounded inner run, but it does not mark the outer Workflow Run completed from that report alone.

**Human-only merge completion**: ThreadLoop reaches completion only when current evidence observes both same-head human
approval and the merged pull request. Executors, delivery infrastructure, GAAP, and RunInvariant cannot substitute for
that human completion boundary.

## Current Term Inventory

Current ThreadLoop code, CLI, and documentation use several compatibility or mechanical terms that should not be treated
as replacements for the glossary terms:

| Current term | Current meaning                                                | Compatibility note                                                  |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `task`       | The user-facing work item currently paired with session state. | Near `Workflow Run`, but not renamed in this issue.                 |
| `session`    | The durable ThreadLoop record targeted by CLI commands.        | Near `Workflow Run`, but remains the current CLI/API term.          |
| `wake`       | A scheduler delivery for one serialized runner action.         | Delivery mechanism, not a Lifecycle State or Transition.            |
| `runner`     | The process or skill that performs one bounded action.         | Executor role, not lifecycle authority.                             |
| `daemon`     | Mechanical refresh loop for active sessions.                   | Refresh infrastructure, not semantic authority.                     |
| `gate`       | A declared proof check or evidence-producing command.          | Supports Guards but is not the full Guard concept.                  |
| `receipt`    | A retained local or signed evidence artifact.                  | Maps to Evidence Receipt when accepted and bound to a Workflow Run. |

No current public term is intentionally renamed by this ADR.
