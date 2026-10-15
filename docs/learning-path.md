# Learning Path

Twenty-two small labs that teach one Pi runtime concept at a time. This page explains the order, what each lab
adds, and where things stand. Each lab's own README is the authority on what its code does; this page only
connects them.

The shared rules (one project per lab, predictions before results, deterministic checks apart from live runs) are in
the root [Working agreement](../README.md#working-agreement). The original pre-build plans are kept in
[docs/design](design/) as history.

## The shape of the path

```text
Phase 1  Agent in memory         01 loop → 02 Teams transport → 03 Teams to Pi → 04 several tools → 05 sessions → 06 failures
Phase 2  Durable runtime         07 session on disk → 08 crash recovery → 09 replay safety        (durable execution)
                                 → 10 compaction → 11 session tree → 12 projection                (context and history)
                                 → 13 tool governance → 14 telemetry and evaluation               (governance and evidence)
Phase 3  Enterprise scenario     15 integration → 16 identity → 17 authorization → 18 approval
                                 → 19 untrusted content → 20 connector reliability → 21 durable effects → 22 release gates
```

Each lab adds **one** concept. That is the point of the order: when something behaves differently, the new
concept is the only thing that changed, so the observation can be attributed to it. Small amounts of code are
copied between labs on purpose, so every lab can be opened and understood on its own.

## Phase 1 — Pi `Agent`, in memory (Labs 01–06)

Goal: see exactly what Pi manages between a prompt, a tool call, a tool result, and the next model turn, then put
Teams in front of it, then break it.

| Lab | Adds | Core question |
| --- | --- | --- |
| [01](../lab-01-pi-agent-loop/README.md) | The agent loop | What does Pi do between a prompt, a tool request, and the final answer? |
| [02](../lab-02-teams-echo/README.md) | Teams transport (no agent) | What does the Teams layer do before any agent runtime is involved? |
| [03](../lab-03-teams-pi/README.md) | A thin adapter around Pi | How does a Teams adapter hand one message to Pi and return its final answer? |
| [04](../lab-04-multi-tool-investigation/README.md) | Several dependent tools | Who decides the order of tool calls, and what runs together? |
| [05](../lab-05-multi-turn-sessions/README.md) | Conversation identity | How does a conversation id pick the right in-memory transcript? |
| [06](../lab-06-failures-and-concurrency/README.md) | Failures and concurrency | What happens when a tool fails, is slow, runs in parallel, or another message arrives mid-run? |

Boundaries: Teams stays a thin transport, never the runtime. Nothing is persisted, so a restart loses every
conversation. That loss is what Phase 2 starts from.

## Phase 2 — Durable runtime (Labs 07–14)

Goal: replace the ephemeral `Agent` with a durable, inspectable, governable runtime, making each guarantee visible
through a small experiment and a deliberate failure. All eight labs use `@earendil-works/pi-durable`.

| Lab | Adds | Core question |
| --- | --- | --- |
| [07](../lab-07-durable-harness-session/README.md) | A session on disk | After a restart, how does a finished conversation pick up where it left off? |
| [08](../lab-08-crash-recovery/README.md) | Crash recovery | If the process is killed mid-tool-call, what does Pi do when the session is reopened? |
| [09](../lab-09-tool-replay-safety/README.md) | Replay safety | May Pi run a tool again after it may already have changed something? |
| [10](../lab-10-context-compaction/README.md) | Context compaction | How can the model read a shorter context while the session keeps everything? |
| [11](../lab-11-session-tree/README.md) | Forking history | What happens to the conversation you left when you go back and change a premise? |
| [12](../lab-12-context-projection/README.md) | Projection | Does every durable application record belong in the model's context? |
| [13](../lab-13-tool-governance/README.md) | Tool governance | How can the application constrain and audit a tool call independently of the prompt? |
| [14](../lab-14-telemetry-evaluation/README.md) | Telemetry and evaluation | How do you know an agent is reliable without judging one final answer? |

Three blocks, in this order:

- **07–09, durable execution.** Do not start Lab 10 until you can explain completed, open, resumed, retried, and
  replayed work.
- **10–12, context and history.** Persisting a session is not proof that every entry reaches the model.
- **13–14, governance and evidence.** Do not claim policy enforcement or a quality gain without deterministic
  evidence.

### Terminology: the original plan vs `pi-durable` 1.1

The Phase 2 design was written against Pi `0.85.1`. The labs use the `pi-durable` `1.1.0` equivalents:

| Original plan (`0.85.1`) | In the labs (`pi-durable` `1.1.0`) |
| --- | --- |
| `AgentHarness`, `lane("main")` | `Harness.open(storage)` and a `root()` conversation |
| `Session`, `JsonlSessionRepo` | a storage from `openNodeJsonlStorage`; entries have an open `kind` (`pi.user`, `pi.assistant`, …) |
| branch tip, `navigateTree()`, labels | `head` marks where model context starts; `conversation.fork(entryId)` makes a separate conversation; labels are an app-level `defineDoc` (Lab 11) |
| `SessionRepo.fork()` into a separate file | not used; Lab 11 uses the in-storage `conversation.fork()` |
| `lane.resume()`, open operations | `harness.inspect()`, `harness.resume()`, `harness.submission(id).wait()` (Lab 08) |
| `replay: "never"`, `invocationId` | `replay: "unsafe"` (the default) or `"safe"`; `api.taskId` / `api.callId` (Lab 09) |
| `lane.compact()`, retained tail | a compaction task plus a write submission; the cut is observed through `head` (Lab 10) |
| `entryProjectors`, `toProviderMessages` | an entry's own `model` field, produced at write time; `hook(GenerationTask, { beforeRequest })` can only check (Lab 12) |
| `activeToolNames`, `before_tool` / `after_tool` handler ids | the conversation's stored tool offer (`root({ agent: { tools } })`, `configure({ tools })`); `hook(ToolTask, { beforeTool, afterTool })` inside an extension, whose name is its identity (Lab 13) |
| Pi's harness telemetry schema and spans | none; the lab declares its own `lab.*` schema over `pi-telemetry` and bridges harness events into it (Lab 14) |

Caveats and measured behavior are in [CLAUDE.md](../CLAUDE.md) ("Pi 1.1 standard").

## Phase 3 — Enterprise assistant scenario (Labs 15–22)

Goal: use the runtime concepts to build a small, inspectable assistant whose identity, authorization, approvals, data
access, execution, and evaluation stay consistent across failures and restarts. One business story runs through
all eight labs:

```text
employee signs in → reads within their authorized scope → proposes a booking change
  → a human approves → the action executes durably → an evidence-backed result
  → the whole run is evaluated against release criteria
```

The data is synthetic: two tenants that both have a booking `BK1001` with different contents; `viewer`,
`operator`, and `approver` roles; several users per tenant; and documents that are ordinary, restricted, stale,
contradictory, or malicious. The only business action is changing one booking's status. These fixtures teach
execution contracts, not real shipment rules.

| Lab | Adds | Core question |
| --- | --- | --- |
| [15](../lab-15-integrated-runtime/README.md) | Integration | When governance, audit, telemetry, egress checks, and a durable session run together, does each guarantee still hold? |
| [16](../lab-16-identity-and-isolation/README.md) | Identity and tenant isolation | Who is asking, and how does that keep one company's data, sessions, and cache from another's? |
| [17](../lab-17-resource-authorization/README.md) | Resource authorization | May this employee do this action on this booking right now? |
| [18](../lab-18-human-approval/README.md) | Durable human approval | After a wait and a restart, does the approval still authorize the exact action about to run? |
| [19](../lab-19-untrusted-context/README.md) | Untrusted content and egress | How can documents be evidence without breaking authorization and action boundaries? |
| [20](../lab-20-connector-reliability/README.md) | Connector reliability and budgets | When an external API is slow, rate-limited, malformed, or partly successful, how does the assistant finish bounded work and report it accurately? |
| [21](../lab-21-durable-effects/README.md) | Durable external effects | If a downstream system completes an action but the response is lost, how do you avoid a duplicate effect and learn the real outcome? |
| [22](../lab-22-observability-and-release/README.md) | Observability and release gates | What evidence justifies a release, and how is a failed run traced to the boundary that failed? |

### Planned chain vs as built

The design chains the labs (16 builds on 15, 17 on 16, …, 22 on 15–21). As built, most of them are independent
projects that copy only what they need and import nothing from each other. That keeps each one inspectable, but
it also means the labs are **not jointly verified**: the [status table](#status) names which earlier labs each one
did not build on, and the end-to-end demonstration below has not been run as one instance.

### How evidence is recorded

- **Three completion states, tracked separately:** *implementation verified* (deterministic checks pass),
  *experiment verified* (the defined integration, failure, and applicable live-model evidence exist), and *learner
  completed* (an explanation and a transfer exercise). A skipped prediction is recorded as `waived`.
- **Verification layers:** unit and contract tests; scripted runtime integration with controlled provider
  responses; local system experiments (HTTP, PostgreSQL, child-process crashes, delivery workers); bounded live
  evaluation; and real enterprise integration, which needs its own authorized environment and evidence.
- **Evidence manifest:** an acceptance run records timestamp and Git SHA (and dirty state), Node/npm/Pi versions,
  model and prompt/tool/policy/fixture hashes, safe command templates, and deterministic, integration, and live
  results separately. Unavailable metadata is recorded as unavailable; a provider alias is not a model snapshot.
- Per-lab worksheets (`WORKSHEET.md`) hold the learner's prediction and explanation; reference explanations
  (`REFERENCE.md`) are kept apart so they are not read first.

### Joint acceptance demonstration (target, not yet run)

The intended end state is one instance that runs these scenarios and inspects durable state and recorded effects,
not just the answer. Today each scenario is exercised only in the lab that owns it.

| Scenario | Required evidence |
| --- | --- |
| Employee queries a booking | Valid identity, resource authorization, tool evidence, and answer sources |
| Employee queries another tenant's booking | Access denied; protected contents absent from the provider payload |
| Employee proposes a change without approval | Pending action; zero business effects |
| Service restarts while approval is pending | Original action and approval binding remain valid and inspectable |
| Approver confirms twice | Only one executable business action is admitted |
| Receiver succeeds but its response is lost | Unknown outcome, then reconciliation and a verified result |
| Document contains malicious instructions | Principal, approval, authorization, and egress contracts remain effective |
| Employee permission is revoked | Old sessions cannot exercise revoked permissions or reuse prohibited content |
| Model change introduces a behavioral regression | Release gate fails with evidence naming the failed contract |

Completion of Phase 3 would demonstrate the reference implementation's tested guarantees. A real enterprise
deployment still needs its own integration, operational, and data-handling acceptance evidence.

## Status

State of the repository on 2026-10-15. Test counts come from `scripts/verify-labs.sh`; "needs PostgreSQL" means the
lab's database tests only run after `npm run db:up` (see [Prerequisites](../README.md#prerequisites)).

| Lab | Pi dependency | Tests | Implementation | Experiment and notes |
| --- | --- | --- | --- | --- |
| 01 | `pi-agent-core` / `pi-ai` 1.1.0 | 21 | Verified | — |
| 02 | none (Teams SDK) | 4 | Verified | — |
| 03 | `pi-agent-core` / `pi-ai` 1.1.0 | 15 | Verified | — |
| 04 | `pi-agent-core` / `pi-ai` 1.1.0 | 31 | Verified | — |
| 05 | `pi-agent-core` / `pi-ai` 1.1.0 | 23 | Verified | — |
| 06 | `pi-agent-core` / `pi-ai` 1.1.0 | 44 | Verified | — |
| 07 | `pi-durable` 1.1.0 | 25 | Verified | — |
| 08 | `pi-durable` 1.1.0 | 35 | Verified | — |
| 09 | `pi-durable` 1.1.0 | 54 | Verified | — |
| 10 | `pi-durable` 1.1.0 | 40 | Verified | — |
| 11 | `pi-durable` 1.1.0 | 48 | Verified | — |
| 12 | `pi-durable` 1.1.0 | 46 | Verified | — |
| 13 | `pi-durable` 1.1.0 | 60 | Verified | — |
| 14 | `pi-durable` 1.1.0, `pi-telemetry` | 121 | Verified | — |
| 15 | `pi-durable` 1.1.0, `pi-telemetry` | 90 | Verified; acceptance criteria AC4 and AC5 partial | Scripted failure injections; no live-model run; prediction waived |
| 16 | `pi-durable` 1.1.0 | 82 | Verified; Lab 15 not built on | Experiment and prediction pending |
| 17 | `pi-durable` 1.1.0 | 143 | Verified; Lab 15 not built on | Local experiments; real OBO not run; prediction waived |
| 18 | `pi-durable` 1.1.0 | 82 (needs PostgreSQL) | Verified; Labs 15 and 17 not used | Scripted demo; no live-model run; prediction waived |
| 19 | `pi-durable` 1.1.0 | 185 | Verified; Labs 15, 17, 18 not used | Scripted demo; no live-model run, no crash run; prediction pending |
| 20 | `pi-durable` 1.1.0 | 167 | Verified; Labs 15, 17, 18, 19 not built on | Scripted demo; no live-model run, no real endpoint check; prediction pending |
| 21 | none (`pg`) | 71 (needs PostgreSQL) | Verified; Labs 15, 17, 19 not built on, Lab 20's connector not reused | Scripted demo; two-process and `SIGKILL` experiments in the suite; no real downstream; prediction pending |
| 22 | `pi-agent-core` / `pi-ai` 1.1.0 (live judge only) | 90 | Verified; Labs 15, 17, 19, 20, 21 not built on; independent review not yet run | Scripted demos; `evaluate:live` not run; prediction waived |

"Not built on" and "not used" mean the lab does not reuse that lab's code. Learner completion is pending for every
Phase 3 lab. Independent reviews, mutation checks, and limits are recorded in each lab's README.

## What is deliberately not covered

- **Phase 1–2 boundaries:** SQLite and other session backends; Pi's remote
  `server`/`protocol`/`client` packages; coding-agent skills, prompt templates, and TUI; hosted telemetry exporters
  and production evaluation infrastructure.
- **Later tracks:** file ingestion and artifact workspaces; sandboxed code execution and browser or desktop
  actions; real Teams/Entra and enterprise connectors (tenant setup, consent, delegated credentials); shared
  multi-instance session storage (atomic append, crash consistency, migrations); deployment and data lifecycle
  beyond a local reference.

Adding any of these during the phases above would make it harder to attribute an observation to the runtime
concept under study.

## Design history

The plans these labs were built from, kept as written:

- [Phase 1 plan](design/ROADMAP.md) (Labs 01–06)
- [Phase 2 plan](design/ROADMAP-PHASE-2.md) (Labs 07–14, written for Pi `0.85.1`)
- [Phase 3 plan](design/ROADMAP-PHASE-3.md) (Labs 15–22)
- [Original POC proposal](design/origin-poc-proposal.md) (a saved discussion that preceded the roadmaps)

They hold each lab's prediction gate, failure injections, and acceptance criteria as originally specified. Those
are the starting point if a new lab is added, and they are not updated when the code changes.
