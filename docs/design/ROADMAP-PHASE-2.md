# Pi Learning Labs — Phase 2 Roadmap

> **Design document, written before the labs were built — not maintained.** It records the original plan for
> Phase 2 (Labs 07–14): core questions, scope, exclusions, prediction gates, failure injections, and acceptance criteria. Names
> and status may differ from the code. For what exists now, read [the learning path](../learning-path.md) and each
> lab's own README. API names are from the Pi version the plan was written against.

This roadmap defines Labs 07–14. Phase 1 established Pi's in-memory execution
semantics: the agent loop, transport boundaries, tool selection, multi-turn state,
failures, steering, follow-up, and parallel tool execution. Phase 2 moves from an
ephemeral `Agent` to a durable, inspectable, and governable agent runtime.

Last reviewed against the repository state: 2026-10-15. This roadmap was written against Pi `0.85.1`; Labs
07–14 are now built on `@earendil-works/pi-durable` `1.1.0` (with `chord` and `pi-ai`; Lab 14 also pins
`@earendil-works/pi-telemetry`).

> **Reading the lab sections.** The API names inside them are the original `0.85.1` names. The labs use the
> `pi-durable` `1.1.0` equivalents listed in the [terminology table](../learning-path.md#terminology-the-original-plan-vs-pi-durable-11).

## Phase 2 outcome

After these labs, the learner should be able to explain and demonstrate:

```text
Agent
  -> durable Session entries
  -> AgentHarness lane and operation state
  -> restart and recovery
  -> tool replay decisions
  -> compacted model context with full durable history
  -> session-tree navigation
  -> application entry projection
  -> tool policy, telemetry, and behavioral evaluation
```

The goal is not to build a production shipment agent. The goal is to make each
runtime guarantee visible through a small experiment, a deliberate contrast or
failure, and inspectable local evidence.

## Repository contract

The rules shared by every lab are in the root [Working agreement](../../README.md#working-agreement). Phase 2 adds:

- Use directories named `lab-07-*` through `lab-14-*`.
- Keep all session state, traces, fixtures, and evaluation artifacts local: no hosted database, remote trace
  backend, or cloud artifact store.
- Continue using the small shipment fixtures from Phase 1 unless a lab needs one additional local fixture to
  expose its target concept.
- Pin Pi package versions within a lab and do not assume a later Pi version preserves earlier behavior.

## Project layout

```text
pi-lab/
├── ROADMAP.md
├── ROADMAP-PHASE-2.md
├── lab-07-durable-harness-session/
├── lab-08-crash-recovery/
├── lab-09-tool-replay-safety/
├── lab-10-context-compaction/
├── lab-11-session-tree/
├── lab-12-context-projection/
├── lab-13-tool-governance/
└── lab-14-telemetry-evaluation/
```

As in Phase 1, limited duplication is intentional. A learner should be able to open
one lab and see the complete experiment without resolving a hidden shared runtime.

## Status

See the status table in [the learning path](../learning-path.md#status).

## Learning loop

Every Phase 2 lab follows the [standard learning loop](../../README.md#standard-learning-loop), inspecting durable
entries, operation results, events, or telemetry rather than judging only the final answer. For process-crash
experiments, a deterministic parent test waits for a named checkpoint before terminating the child; it does not
depend on human timing or arbitrary sleeps.

---

## Lab 07 — Durable AgentHarness Session

### Core question

How does a completed conversation survive a process restart, and which responsibility
belongs to `Session`, `AgentHarness`, and a lane?

### Mental model

```text
conversation ID
  -> open or create local JSONL Session
  -> AgentHarness
  -> lane("main")
  -> prompt and completed operation
  -> close process

same session ID after restart
  -> reopen JSONL Session
  -> recreate AgentHarness
  -> lane("main")
  -> follow-up sees the durable transcript
```

### Scope

- Use `JsonlSessionRepo` with a lab-local ignored session directory.
- Introduce `AgentHarness` and one `main` lane.
- Preserve the Lab 05 two-turn scenario: ask for `BK1001`, restart after the first
  completed operation, then ask which container it uses.
- Log session ID, lane name, operation ID, entry IDs, branch tip, and terminal
  operation status.
- Test session creation, close and reopen, same-session continuation, and
  cross-session isolation.
- Inspect the JSONL entry sequence without hand-editing it.

### Explicitly excluded

- Killing the process during an active operation.
- `resume()`, tool replay, provider retry, compaction, and tree navigation.
- SQLite and any remote session backend.
- Teams transport; use a terminal CLI so transport behavior does not obscure the
  persistence boundary.

### Prediction gate

Predict which completed messages and tool results survive restart, whether a lane is
the same thing as a session, how the branch tip changes, and what a different session
can observe.

### Contrast case

Run the same follow-up against a newly created session and verify that it does not
inherit the first session's booking context.

### Evidence to collect

- Deterministic repository lifecycle and isolation tests.
- JSONL entry IDs and parent IDs before and after restart.
- One bounded live trace showing the reopened session answering from prior evidence.
- A terminal operation result for each prompt.

### Completion criteria

- A completed transcript survives a clean process restart.
- Reopening does not duplicate user, assistant, or tool-result entries.
- A different session remains isolated.
- The learner can distinguish conversation identity, session identity, lane identity,
  and operation identity.
- The learner can explain why durable history alone does not prove that in-flight work
  is recoverable.

---

## Lab 08 — Crash Recovery

### Core question

What durable state lets `AgentHarness` continue an operation that was interrupted by
process death?

### Mental model

```text
prompt accepted
  -> durable operation and checkpoint
  -> assistant requests a slow read-only tool
  -> process terminates at a named checkpoint

reopen session
  -> recreate harness
  -> inspect open operation
  -> lane.resume()
  -> one terminal operation result
```

### Scope

- Extend Lab 07 with one intentionally slow, read-only fixture tool.
- Start the agent in a child process and terminate it from a parent process only after
  a deterministic checkpoint signal.
- Reopen the same JSONL session and inspect the open operation before calling
  `resume()`.
- Record recovery-marked events, operation state before restart, and the final
  operation result.
- Test repeated `resume()` calls after settlement to make the terminal behavior
  explicit.

### Explicitly excluded

- State-changing tools and comparison of replay policies; those belong to Lab 09.
- Compaction, tree navigation, provider failover, and distributed workers.
- OS-level chaos testing or random kill timing.

### Prediction gate

Predict what is already durable at the selected checkpoint, what `resume()` must do,
which identifiers remain stable, and whether a settled operation can be resumed again.

### Failure injection

Terminate the child process after the operation is durable but before the tool outcome
has been committed. Do not kill at an arbitrary wall-clock delay.

### Evidence to collect

- The last durable operation state before termination.
- The open operation discovered after reopening.
- Recovery events and stable operation, turn, and invocation identifiers.
- Exactly one terminal operation result.

### Completion criteria

- The interrupted session reopens without manual JSONL repair.
- `resume()` advances the open operation to a terminal result.
- No second user prompt is appended as part of recovery.
- The learner can distinguish reopening a completed session from resuming an open
  operation.
- The recovery test is deterministic and does not depend on arbitrary sleeps.

---

## Lab 09 — Tool Replay Safety

### Core question

When a process dies after a tool effect may have happened, how does Pi decide whether
that tool may run again?

### Mental model

```text
durable tool intent
  -> effect outcome known       -> commit result
  -> effect outcome unknown
       -> replay: "safe"        -> recovery may execute again
       -> replay: "never"       -> recovery must not repeat the effect

application idempotency
  !=
Pi replay policy
```

### Scope

- Define one read-only tool with `replay: "safe"`.
- Define one local state-changing tool with `replay: "never"`; its only effect is an
  append to a lab-local outbox fixture.
- Use `AgentHarnessToolInvocation.invocationId` in audit records.
- Use invocation-scoped memos only where they clarify the difference between durable
  runtime bookkeeping and business idempotency.
- Terminate at named checkpoints around each tool and inspect recovery behavior.
- Count actual tool executions separately from committed tool-result entries.

### Explicitly excluded

- Real notifications, bookings, APIs, or any external side effect.
- Provider retry policy and HTTP retry behavior.
- Exactly-once claims across systems Pi does not control.
- Production outbox delivery and distributed transaction protocols.

### Prediction gate

Predict the behavior for an unknown outcome under each replay policy, whether the
logical invocation ID changes, and which layer must prevent a duplicated business
effect.

### Failure injections

- Kill the process after the safe tool starts but before its result is committed.
- Kill the process after the non-replayable tool appends its local effect but before
  Pi commits the tool result.

### Evidence to collect

- Tool-attempt log, invocation IDs, outbox contents, harness recovery events, and the
  terminal operation result for each policy.
- A table distinguishing attempts, effects, durable results, retries, and replays.

### Completion criteria

- The safe tool's recovery behavior is visible and evidence-backed.
- The non-replayable tool is not invoked a second time after an unknown outcome.
- The local outbox contains no duplicated business effect.
- The learner can distinguish replay safety, retry, and application idempotency.
- The README avoids claiming universal exactly-once execution.

---

## Lab 10 — Context Compaction

### Core question

How can the model receive a shorter context while the durable session retains the
full conversation history?

### Mental model

```text
durable branch entries
  -> compaction selects older messages
  -> summary entry + retained tail
  -> shorter provider context

full durable history remains inspectable
```

### Scope

- Seed a deterministic long conversation containing early identifiers, tool evidence,
  and later follow-up turns.
- Measure estimated context tokens before compaction.
- Run explicit `lane.compact()` with a small, documented compaction configuration.
- Inspect the compaction entry, summary, retained tail, token count, and usage.
- Continue the conversation and verify which earlier facts remain usable.
- Add custom compaction instructions in one contrast run to preserve a named critical
  fact.

### Explicitly excluded

- Session-tree navigation and branch summaries.
- Vector retrieval, long-term memory, RAG, or an external document store.
- Treating a generated summary as lossless storage.
- Model-provider benchmarking.

### Prediction gate

Predict which messages are summarized, which tail messages remain verbatim, whether
the original entries are deleted, and which early detail is most vulnerable to loss.

### Failure or contrast case

Place one important booking fact only in the early history. Compare default compaction
with compaction instructions that explicitly preserve shipment identifiers and known
evidence gaps.

### Evidence to collect

- Context-token estimate before and after compaction.
- The durable compaction entry and retained tail.
- The full pre-compaction entries still present in the session tree.
- Follow-up answers before and after the contrast compactions.

### Completion criteria

- Provider context becomes smaller while full durable history remains inspectable.
- The summary never invents a shipment identifier or unsupported cause.
- The learner can explain why compaction is lossy even when the session file is not.
- The learner can distinguish compaction from retrieval and from deleting history.

---

## Lab 11 — Session Tree and Navigation

### Core question

How does Pi preserve alternative continuations when the learner returns to an earlier
point and changes an assumption?

### Mental model

```text
entry A -> entry B -> entry C
                  \
                   -> entry D -> entry E

one session tree, two branch tips, no overwritten history
```

### Scope

- Start with one completed shipment-investigation branch.
- Label a meaningful entry and navigate back to it with `navigateTree()`.
- Continue with a changed user premise to create an alternative branch.
- Enumerate parent IDs, branch tips, labels, and the active lane tip.
- Switch between both continuations and verify that neither is overwritten.
- Compare unsummarized navigation with one summarized-navigation experiment only if
  the unsummarized path is already understood.

### Explicitly excluded

- Forking into a separate session file with `SessionRepo.fork()`.
- Collaborative editing, branch merging, and Git semantics.
- Compaction tuning beyond what was learned in Lab 10.
- UI tree rendering.

### Prediction gate

Draw the expected entry tree before navigation. Predict the new parent ID, which tip
becomes active, what remains reachable, and whether navigation mutates old entries.

### Contrast case

Ask the same follow-up from two different historical points and prove that each answer
uses the context of its own branch.

### Evidence to collect

- Before-and-after tree diagrams generated from durable entry IDs and parent IDs.
- Labels, active tip changes, navigation events, and both final answers.

### Completion criteria

- Navigation creates an alternative continuation without deleting the original one.
- Both branches remain addressable after restart.
- Branch-specific prompts see only the expected ancestral context.
- The learner can distinguish session, lane, branch, and a separate forked session.

---

## Lab 12 — Durable Entries and Model Context Projection

### Core question

Does every durable application record belong in the model's context?

### Mental model

```text
durable session branch
  -> message entries ---------------------> model context
  -> custom application entries
       -> no projector -------------------> durable only
       -> entryProjector -----------------> approved AgentMessage
  -> toProviderMessages -----------------> final provider payload
```

### Scope

- Add one custom `case_note` entry type with structured local fixture data.
- Persist notes that are intentionally invisible to the model by default.
- Add an `entryProjectors` function that exposes only an approved subset.
- Add one `toProviderMessages` check that makes the final provider boundary visible.
- Test projection ordering, omission, deterministic sanitization, and behavior after
  session reopen.
- Log entry IDs and projected message types, never secret values.

### Explicitly excluded

- Retrieval, embeddings, vector stores, and long-term semantic memory.
- Using model prompts as the only authorization boundary.
- Real customer data, credentials, or production access-control rules.
- Building a general event-sourcing framework.

### Prediction gate

Predict which records are durable, which records reach the provider, whether an
unprojected custom entry affects the answer, and where sanitization must occur.

### Failure injection

Include an internal-only field in the custom entry and verify deterministically that
it is absent from the projected provider messages and final answer.

### Evidence to collect

- Durable custom entry data, sanitized projected messages, and the final provider
  message list with sensitive fixture values redacted from logs.
- Tests proving that projection remains correct after session reopen.

### Completion criteria

- Custom entries survive restart without automatically entering model context.
- The projector exposes only the documented subset.
- Internal-only fixture data is absent from provider messages and final output.
- The learner can distinguish durable history, agent messages, projected context, and
  provider messages.

---

## Lab 13 — Tool Governance and Runtime Hooks

### Core question

How can the application constrain and audit a model-requested tool call independently
of the prompt?

### Mental model

```text
model proposes tool call
  -> active-tool configuration
  -> before_tool policy hook
       -> allow or decline
  -> tool effect
  -> after_tool hook
       -> audit or bounded result transformation
  -> durable tool result
```

### Scope

- Keep the read-only investigation tools and add one local state-changing candidate
  tool that is disabled by default.
- Use active-tool configuration to control which tools are advertised.
- Register `before_tool` and `after_tool` harness hooks with stable handler IDs.
- Enforce one deterministic local policy based on structured tool arguments and
  tool context, not natural-language pattern matching.
- Persist an append-only local audit record containing IDs and decisions but no
  secrets.
- Verify fail-closed behavior when the policy hook throws.

### Explicitly excluded

- Entra identity, RBAC, OBO, or delegated production tokens.
- Prompt-only security and model self-authorization.
- Real shipment updates or external side effects.
- General policy engines and distributed audit pipelines.

### Prediction gate

Predict whether a disabled tool can be requested, when the policy hook runs relative
to execution, what is persisted for a declined call, and what happens when the policy
hook itself fails.

### Failure injections

- Ask the model to perform a locally prohibited update.
- Make the policy hook throw and verify that the tool does not execute.
- Make the audit sink fail and document whether that failure is fail-open or
  fail-closed for this lab's explicit policy.

### Evidence to collect

- Advertised active-tool list, hook events, policy decision, tool-attempt count,
  durable result, and local audit record.

### Completion criteria

- Prohibited tool effects never execute.
- Allowed read-only calls continue to work.
- Hook failure follows the documented fail-closed policy.
- Audit records correlate session, lane, operation, turn, and tool invocation IDs.
- The learner can explain why system prompts are not an authorization mechanism.

---

## Lab 14 — Typed Telemetry and Behavioral Evaluation

### Core question

How can we prove that a Pi agent is reliable without judging only one final answer?

### Mental model

```text
fixed local scenarios
  -> harness operations
       -> typed spans and events
       -> durable transcripts
       -> deterministic outcome checks
       -> bounded live-model scores
  -> evidence-backed comparison
```

### Scope

- Use `InMemoryTelemetryContext` and Pi's typed AI and harness telemetry schemas.
- Capture parent-child spans for run, turn, provider request, tool, retry, recovery,
  compaction, and navigation paths exercised by prior labs.
- Build a small frozen local evaluation set from the existing shipment fixtures.
- Grade deterministic invariants separately from semantic answer quality.
- Include checks for required tool evidence, identifier provenance, unsupported causal
  claims, terminal operation status, duplicate effects, token usage, and latency.
- Run one bounded live-model comparison with an explicit model ID, prompt version,
  case list, and repetition count.
- Store reports and raw artifacts locally in an ignored directory.

### Explicitly excluded

- Hosted telemetry, MLflow, OpenTelemetry exporters, dashboards, and alerting.
- Importing Pi's private monorepo eval package as if it were a public application API.
- Large regression suites, model leaderboards, or statistically strong production
  claims from a tiny sample.
- Changing prompts or policies during a frozen comparison.

### Prediction gate

Predict which facts can be graded deterministically, which require a semantic judge,
the expected span parentage, and what one live run cannot establish.

### Failure injections

- Remove one required tool result and verify that evidence coverage fails even if the
  prose sounds plausible.
- Produce a duplicated local effect and verify that the side-effect invariant fails.
- Remove one expected telemetry span and report it as unavailable rather than zero.

### Evidence to collect

- Normalized in-memory spans, durable transcripts, per-case deterministic checks,
  live-model observations, aggregate report, and the exact experiment manifest.

### Completion criteria

- Span parentage and required attributes are tested deterministically.
- Evaluation separates infrastructure failures, missing observations, deterministic
  contract failures, and semantic quality scores.
- A polished but ungrounded answer cannot pass the evidence checks.
- Results are bound to exact model, prompt, fixture, case, and repetition identities.
- The learner can explain why one successful chat is not an evaluation.

---

## Recommended sequence and dependency boundaries

```text
Lab 07 durable completed history
  -> Lab 08 in-flight recovery
  -> Lab 09 unknown tool outcomes
  -> Lab 10 bounded model context
  -> Lab 11 alternative history branches
  -> Lab 12 application-to-model projection
  -> Lab 13 runtime governance
  -> Lab 14 evidence and evaluation
```

- Labs 07–09 form the durable-execution block. Do not start Lab 10 until the learner
  can explain completed, open, resumed, retried, and replayed work.
- Labs 10–12 form the context-and-history block. Do not treat session persistence as
  proof that every entry is visible to the model.
- Labs 13–14 form the governance-and-evidence block. Do not claim policy enforcement
  or quality improvement without deterministic evidence.

## Topics intentionally deferred until after Lab 14

- SQLite session backend and storage-backend performance comparisons.
- Forking into a separate session file (Lab 11 uses a second conversation in the same storage).
- Real Teams sideloading, tenant authentication, Entra SSO, delegated tokens, OBO,
  and production RBAC.
- External shipment APIs, Databricks, file ingestion, sandboxing, and artifact stores.
- Pi remote `server`, `protocol`, and `client` packages.
- Pi coding-agent skills, prompt templates, extensions, themes, and TUI components.
- Chord services, replicated state, RPC, and plugin composition.
- Hosted telemetry exporters and production evaluation infrastructure.

These are valid later tracks, but adding them during Phase 2 would make it harder to
attribute an observation to the Pi runtime concept under study.

## Documentation baseline

Revalidate these sources when beginning each lab:

- [Pi agent core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)
- [Pi agent core source](https://github.com/earendil-works/pi/tree/main/packages/agent)
- [Pi telemetry README](https://github.com/earendil-works/pi/blob/main/packages/telemetry/README.md)
- [Pi AI README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)
- [Pi evals README](https://github.com/earendil-works/pi/blob/main/packages/evals/README.md)
- [Pi package index](https://github.com/earendil-works/pi/tree/main/packages)

The implementation baseline is the packaged type declarations of the version a lab pins (`pi-durable` `1.1.0` for
Labs 07–14). The `pi-durable` README marks it Experimental, so its API can change without notice. Do not mix APIs
from two versions silently.

## New-session handoff

Follow [Starting or resuming a lab](../../README.md#starting-or-resuming-a-lab), reading this roadmap as the phase
roadmap. Phase 2 adds: restate the lab's recovery assumptions along with its failure injection, and revalidate the
exact Pi package version the lab pins.
