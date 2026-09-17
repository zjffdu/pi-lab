# Pi Learning Labs Roadmap

This roadmap defines six independent projects that build one mental model at a time, from the Pi core loop to Teams transport, multi-tool reasoning, conversation state, and concurrency.

Last reviewed against current SDK documentation: 2026-09-17.

## Repository contract

- Keep one Git repository with one self-contained project per lab at the repository root.
- Use directories named `lab-01-*` through `lab-06-*`; do not add an intermediate `labs/` directory.
- Give every lab its own `package.json`, lockfile, source, tests, fixtures, and README.
- Keep completed labs runnable. Do not turn earlier labs into shared packages or silently upgrade their dependencies.
- Work on one active lab at a time. Do not scaffold or implement a later lab unless the user explicitly asks.
- Start each experiment with a written prediction. Do not publish the expected learner answer before the prediction is recorded.
- Separate deterministic checks from live model or Teams smoke tests.
- Pin SDK versions and revalidate current external documentation when a new lab starts.
- Keep secrets in ignored `.env` files. Commit only `.env.example` files with empty values.
- Use local fixtures until a later roadmap explicitly introduces an external data system.
- Commit only when the user explicitly requests it.

## Project layout

```text
pi-lab/
├── ROADMAP.md
├── README.md
├── lab-01-pi-agent-loop/
├── lab-02-teams-echo/
├── lab-03-teams-pi/
├── lab-04-multi-tool-investigation/
├── lab-05-multi-turn-sessions/
└── lab-06-failures-and-concurrency/
```

Do not introduce a shared runtime package during these six labs. A small amount of duplication keeps each experiment inspectable and prevents a later change from rewriting earlier evidence.

## Current status

| Lab | Focus | Status |
| --- | --- | --- |
| 01 | Pi Agent Loop | Implemented and verified |
| 02 | Teams Echo | Implemented and verified |
| 03 | Teams to Pi | Implemented and verified |
| 04 | Multi-tool Investigation | In progress |
| 05 | Multi-turn Sessions | In progress |
| 06 | Failures and Concurrency | Implemented and verified |

Directory presence is not evidence of completion. A lab is complete only when all of its acceptance criteria have current verification evidence.

## Standard learning loop

Every lab follows the same sequence:

1. Read the lab goal, boundaries, and vocabulary.
2. Record predictions before running the new behavior.
3. Implement the smallest path that exposes the target concept.
4. Run deterministic type checks and tests.
5. Run one bounded live happy-path smoke test.
6. Inject the lab's defined failure or contrast case.
7. Explain the observed trace in the learner's own words.
8. Record evidence and unresolved uncertainty in the lab README.

The learner explanation is part of the acceptance criteria. A green command without a correct mental model is not sufficient.

---

## Lab 01 — Pi Agent Loop

### Core question

What does Pi manage between a user prompt, an LLM tool call, a tool result, and the next LLM turn?

### Mental model

```text
user prompt
  -> LLM turn 1
  -> get_booking
  -> toolResult message
  -> LLM turn 2
  -> final answer
```

### Scope

- A terminal CLI.
- One in-memory core `Agent`.
- One read-only `get_booking` tool.
- One local booking fixture.
- Lifecycle logging for agent, turn, message, and tool events.
- A known booking and an unknown-booking error path.

### Explicitly excluded

- Teams and HTTP transport.
- Multiple tools.
- Multi-turn conversation state.
- Persistent `Session` storage and `AgentHarness`.
- Steering, follow-up, and parallel tool execution.

### Prediction gate

Predict the number of LLM turns, the location of the tool result in the transcript, and the behavior for an unknown booking.

### Evidence to collect

- Deterministic repository and tool tests.
- A `BK1001` trace with a successful tool call and two LLM turns.
- A `BAD_ID` trace with a tool error and no fabricated booking.

### Completion criteria

- Type checking and deterministic tests pass.
- The final answer uses only fixture evidence.
- The learner can explain why the second LLM turn starts automatically.
- Provider failures return a non-zero process exit code.

### Project

[Lab 01 — Observe the Pi Agent Loop](lab-01-pi-agent-loop/README.md)

---

## Lab 02 — Teams Echo

### Core question

What does the Teams layer do before any agent runtime is involved?

### Mental model

```text
Agents Playground
  -> POST /api/messages
  -> Teams SDK message handler
  -> send(echo response)
  -> Agents Playground
```

Teams SDK is the transport adapter. It is not the agent runtime.

### Scope

- TypeScript and `@microsoft/teams.apps`.
- A local server on port `3978`.
- One `app.on("message", ...)` handler.
- Microsoft 365 Agents Playground as the first client.
- A thin echo function that can be tested without HTTP.
- Logs for message received, handler invoked, and reply sent.

### Explicitly excluded

- Pi and all model providers.
- Tools and fixture lookup.
- Real Teams sideloading, dev tunnels, tenant registration, and SSO.
- Conversation history and persistence.
- Production authentication. `skipAuth` is allowed only for the local Playground.

### Prediction gate

Predict which component owns `/api/messages`, which code creates the reply, and why a transport test does not need an LLM.

### Implementation milestones

1. Implement and unit-test a pure echo function.
2. Register the Teams message handler.
3. Initialize the Teams app and start the server.
4. Connect Agents Playground to `http://localhost:3978/api/messages`.

### Failure injection

- Point the Playground at a wrong endpoint and distinguish transport failure from handler failure.
- Disable local `skipAuth` and observe the expected unauthenticated-request rejection.

### Completion criteria

- Type checking and echo tests pass.
- Agents Playground receives the exact echo response.
- Logs show one received message and one sent reply.
- The learner can explain why no Pi event exists in this lab.
- The README warns that `skipAuth` must never be used in production.

---

## Lab 03 — Teams to Pi

### Core question

How does a thin Teams adapter hand one message to Pi and return Pi's final answer?

### Mental model

```text
Teams message
  -> thin adapter
  -> new Pi Agent for this request
  -> DeepSeek
  -> get_booking
  -> final answer
  -> Teams reply
```

### Scope

- Combine the proven Lab 01 Agent Loop with the proven Lab 02 transport.
- Reuse the single `get_booking` capability and local fixture.
- Create a fresh agent for each incoming message.
- Keep the Teams handler responsible only for input extraction, delegation, and reply delivery.
- Correlate Teams transport logs and Pi lifecycle logs with one request ID.
- Test the adapter with a fake agent runner; keep live model calls out of deterministic tests.

### Explicitly excluded

- More than one tool.
- Conversation-scoped agent reuse and multi-turn context.
- Parallel user messages.
- Real Teams tenant deployment, SSO, and persistence.

### Prediction gate

Predict which logs belong to Teams, which belong to Pi, and where a provider failure should be translated into a safe Teams reply.

### Implementation milestones

1. Define a small `AgentRunner` boundary returning a final answer.
2. Adapt the Lab 01 agent behind that boundary.
3. Inject the runner into the Teams handler.
4. Add one request ID to both transport and runtime logs.
5. Verify the path in Agents Playground.

### Failure injection

- Query `BAD_ID` and verify that a tool error becomes a bounded not-found reply.
- Remove provider configuration and verify that transport remains alive while the request returns a safe infrastructure error.

### Completion criteria

- Deterministic adapter and tool tests pass.
- A Playground request produces an actual Pi lifecycle and one Teams reply.
- The reply for `BK1001` is fixture-backed.
- The learner can trace one request across transport, runtime, tool, and response boundaries.

---

## Lab 04 — Multi-tool Shipment Investigation

### Core question

How does Pi choose and chain multiple tools when later tool arguments depend on earlier results?

### Mental model

```text
get_booking(bookingNo)
  -> containerNo + origin
  -> get_container_events(containerNo)
  -> get_port_status(origin)
  -> evidence-based synthesis
```

After `get_booking`, container events and port status are independent and may be requested in the same tool batch. Exact turn count is not an acceptance criterion.

### Scope

- Three tools: `get_booking`, `get_container_events`, and `get_port_status`.
- Three local, timestamped fixtures.
- Explicit dependencies between tool arguments.
- Pi's default parallel tool execution for independent calls.
- A timeline showing tool-call source order, start time, end time, and transcript insertion order.
- A narrow, documented risk rule.

### Domain rule

- A `LOAD` event later than `plannedDeparture` is evidence of a departure delay.
- High port congestion is an additional risk signal.
- Congestion must not be claimed as the proven cause of the delay.
- All timestamps include a timezone or an explicit UTC suffix.
- Port status includes an `observedAt` timestamp.

### Explicitly excluded

- External shipment APIs and Databricks.
- Business authorization and production decisions.
- Multi-turn conversation state.
- Durable workflow execution.

### Prediction gate

Predict the first required tool, which later tools can run in parallel, and which conclusions the evidence cannot support.

### Failure injection

- Remove one port-status fixture and require the final answer to identify missing evidence.
- Delay one independent tool and observe completion order versus transcript result order.

### Completion criteria

- Each tool has deterministic success and not-found tests.
- The model obtains all required evidence without invented identifiers.
- The final answer separates observed delay, risk signal, and unknown causality.
- The learner can explain dependencies, parallelism, and why exact turn count may vary.

---

## Lab 05 — Multi-turn In-memory Sessions

### Core question

How does conversation identity select the correct in-memory Pi transcript?

### Mental model

```text
conversation A -> Agent A -> transcript A
conversation B -> Agent B -> transcript B
```

### Scope

- A `Map<conversationId, Agent>` session registry.
- Reuse one agent for successive messages in the same conversation.
- Isolate different conversation IDs.
- Follow-up questions that refer to prior tool results.
- Tests for agent reuse, cross-conversation isolation, and registry reset.
- Explicitly accept that a server restart loses every conversation.

### Explicitly excluded

- Database or file-backed session persistence.
- Persistent `Session` storage, `AgentHarness`, SQLite, compaction, and recovery.
- Simultaneous messages in one conversation; that belongs to Lab 06.
- SSO and authorization identity.

### Prediction gate

Predict what the second user message can see, what another conversation can see, and what survives a server restart.

### Live scenario

```text
User: What are the details for BK1001?
Agent: ...
User: Which container is it using?
Agent: ...uses prior transcript...
```

Run the same follow-up in a different conversation and verify that it lacks the first conversation's context.

### Failure injection

- Restart the server between the first question and follow-up.
- Verify that the loss of context is visible and documented, not silently hidden.

### Completion criteria

- Registry tests prove reuse and isolation.
- A same-conversation follow-up uses prior context.
- A different conversation cannot access that context.
- The learner can explain the difference between runtime message history and durable persistence.

---

## Lab 06 — Failures and Concurrency

### Core question

What does Pi do when tools fail, run slowly, execute in parallel, or receive another user message during an active run?

### Scope

- Add monotonic timestamps, turn numbers, `toolCallId`, and conversation ID to trace logs.
- Keep the three local tools from Lab 04 and the in-memory registry from Lab 05.
- Compare `steer()` with `followUp()` using one intentionally slow tool.
- Observe Pi's default parallel tool execution.
- Define one explicit policy for a second message arriving while the same conversation is active.
- Verify that errors and concurrency never duplicate or reorder persisted tool-result messages.

### Experiments

#### Experiment A — Tool error

Call `get_booking("BAD_ID")`. The tool throws; Pi converts the failure into a tool-error message for the next LLM turn.

#### Experiment B — Slow tool and steering

Delay `get_port_status`. Queue a steering message while the tool is active. Observe that steering is delivered after the current assistant turn finishes its tool calls.

#### Experiment C — Follow-up queue

Queue a follow-up message during the same run. Observe that it waits until the agent would otherwise stop.

#### Experiment D — Parallel tools

Request container events and port status in one assistant message. Tool end events may follow completion order, while transcript tool-result messages remain in the assistant's source order.

### Explicitly excluded

- Durable recovery after process failure.
- Distributed workers and workflow engines.
- Database-backed operation state.
- Production retry, rate-limit, and idempotency policies.
- `AgentHarness`; it is the natural next topic after these six labs.

### Prediction gate

Predict the ordering of start, end, tool-result, steering, follow-up, and `agent_end` events for each experiment.

### Completion criteria

- Tool failures produce bounded answers without fabricated evidence.
- The chosen same-conversation concurrency policy is deterministic and tested.
- Steering and follow-up appear at their documented boundaries.
- Independent tool executions overlap when parallel mode is enabled.
- Each tool call produces exactly one final tool-result message.
- The learner can reconstruct the full timeline from logs without relying on the final answer alone.

---

## After Lab 06

Continue with [Phase 2 — Durable Agent Runtime](ROADMAP-PHASE-2.md) only after all
six Phase 1 labs are complete. Phase 2 introduces these topics one at a time:

- persistent `Session` storage with `JsonlSessionRepo`
- durable `AgentHarness`
- SQLite or another session backend
- real Teams sideloading and tenant authentication
- Entra SSO, delegated tokens, OBO, and RBAC
- external shipment APIs, Databricks, files, sandboxing, or artifacts

Each future lab should add one of these concepts, not several at once.

## Documentation baseline

Revalidate these sources when beginning a new lab because SDK behavior can change:

- [Pi core Agent README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)
- [Microsoft Teams SDK TypeScript quickstart](https://github.com/microsoft/teams-sdk/blob/main/teams.md/src/components/include/getting-started/quickstart/typescript.incl.md)
- [Microsoft 365 Agents Playground](https://github.com/microsoft/teams-sdk/blob/main/teams.md/docs/main/developer-tools/agents-playground/README.md)

## New-session handoff

Use this sequence when another session starts or resumes a lab:

1. Read this entire `ROADMAP.md`.
2. Read the root `README.md`.
3. Read the active lab's `README.md` and architecture document if present.
4. Inspect current Git status and preserve unrelated or untracked work.
5. Verify the previous lab's stated completion evidence; do not infer completion from directory presence.
6. Restate the active lab's core question, scope, exclusions, predictions, and verification plan.
7. Stop before implementation if the learner has not supplied the required prediction, unless the user explicitly overrides that gate.
8. Implement only the active lab and record actual evidence after verification.

Suggested opening request for a future session:

```text
Read ROADMAP.md and the active lab documents. We are starting Lab NN.
Do not implement later labs. First restate the scope, prediction gate,
and verification plan, then guide me through the lab.
```
