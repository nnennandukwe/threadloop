# ThreadLoop

ThreadLoop defines the public language for a proof-carrying software-delivery lifecycle. This glossary keeps the SDLC
graph terms separate from agent harnesses, conformance systems, executors, and delivery infrastructure.

## Language

**Workflow Profile**: A named workflow definition that describes the lifecycle states, transitions, guards, and required
actions for a class of software-delivery work. _Avoid_: pipeline config, harness policy

**Compiled Graph**: A deterministic lifecycle graph derived from a Workflow Profile for evaluation by ThreadLoop.
_Avoid_: task graph, runtime plan

**Workflow Run**: One durable instance of ThreadLoop's outer SDLC graph for a bounded software-delivery change. A
Workflow Run owns lifecycle state and evidence context until it is blocked or completed through the human boundary.
_Avoid_: Agent Run, model run, chat session

**Lifecycle State**: A named position in a Workflow Run that represents which authority can act next. _Avoid_: progress
label, phase label

**Transition**: A guarded movement from one Lifecycle State to another in a Workflow Run. _Avoid_: state update, status
change

**Guard**: A condition that must be satisfied before a Transition can advance a Workflow Run. _Avoid_: advisory check,
confidence score

**Required Action**: ThreadLoop's statement of the external action needed before a blocked Guard can pass. _Avoid_: work
item, task ticket, work order

**Action Request**: A bounded request for an actor or executor to perform exactly one action for a Workflow Run.
_Avoid_: work order, job ticket

**Execution Claim**: A claim that an executor has accepted responsibility for one Action Request without gaining
authority over the next Lifecycle State. _Avoid_: lease, ownership transfer

**Attempt**: One execution of an Action Request or evidence-producing step whose result can be retained and compared
with later evidence. _Avoid_: Workflow Run, Agent Run

**Evidence Receipt**: A retained claim about observed work, verification, review, approval, or merge state that can be
evaluated by Guards. _Avoid_: telemetry event, status note

**Authority Boundary**: A point in the graph where the authority to choose or approve the next action belongs to a
different actor or system. _Avoid_: implementation layer, integration point

**Agent Run**: One bounded inner harness execution in which an agent reasons, calls tools, and may produce changes or
evidence for a Workflow Run. GAAP or another compatible harness can own an Agent Run. _Avoid_: Workflow Run, outer loop

**Model/Tool Loop**: The cycle inside an Agent Run where a model reasons, calls tools, observes results, and decides its
next tool action. _Avoid_: Workflow Run, outer SDLC feedback loop

**Outer SDLC Feedback Loop**: The software-delivery feedback cycle that moves through implementation, verification,
review, repair, and human completion according to evidence. _Avoid_: Model/Tool Loop, Agent Run
