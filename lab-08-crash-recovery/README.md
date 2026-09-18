# Lab 08 — Crash Recovery

Kill the process. Not gracefully — `SIGKILL`, mid tool call, no chance to clean up. This lab
answers what a completed transcript (Lab 07's whole subject) does **not** answer: can
`AgentHarness` continue an operation that a process death interrupted, and what exactly does
it do with the tool call that was in flight when the lights went out.

## Learning objective

By the end of this lab, you can explain this from your own console output and JSONL files:

```text
prompt accepted
  -> durable operation and checkpoint
  -> assistant requests a slow read-only tool
  -> process terminates at a named checkpoint (after dispatch, before the tool settles)

reopen session
  -> recreate harness
  -> inspect the open operation
  -> lane.resume()
  -> one terminal operation result

resume again after settlement
  -> NothingToResume, explicitly — not a replay, not a re-run
```

This lab extends [Lab 07](../lab-07-durable-harness-session/README.md)'s `Session ->
AgentHarness -> lane("main")` stack with one new tool and one new failure mode. It does
**not** cover state-changing tools or comparing replay policies (that is Lab 09), compaction
(Lab 10), tree navigation (Lab 11), provider failover, distributed workers, or OS-level chaos
testing — this lab kills exactly one process at exactly one named checkpoint, on purpose,
every time.

## Vocabulary (read before predicting)

- **Open operation** — a lane's last `run`/`compaction`/`navigation` operation that was never
  driven to a terminal (`completed`/`declined`/`aborted`/`failed`) result. `AgentHarness.create()`
  reports these as `open: OpenOperation[]` the instant it attaches to a session — this is how
  a new process discovers that the previous one died mid-flight, without you writing any
  detection logic yourself.
- **Checkpoint** (roadmap sense) — the deterministic signal this lab's fixture tool prints the
  moment it starts executing, which the parent orchestrator script waits for before sending
  `SIGKILL`. Not to be confused with...
- **Checkpoint** (internal `pi.op.state.at` sense) — a durable phase name inside the harness's
  own operation state machine (`"starting"`, `"checkpoint"`, `"assistant.ready"`,
  `"assistant.effect_pending"`, `"tools"`, ...). You will see this word used both ways in this
  README; context disambiguates it every time.
- **`resume()`** — the one lane method this lab is actually about. It does not "replay a
  transcript"; it inspects the durable operation state left behind and drives it forward from
  wherever it stopped, exactly once, to a terminal result.
- **Replay policy** (`"never"` / `"safe"`) — an internal per-tool-call field this lab
  *observes* but does not configure or compare (that is Lab 09's subject). You will see it in
  the raw JSONL in section 5.

## Prerequisites

- Node.js 24.5 or newer
- npm
- Credentials for a model provider supported by `@earendil-works/pi-ai`

The default configuration uses DeepSeek V4 Flash through the official DeepSeek API, same as
every earlier lab.

## API note (revalidated against the pinned version)

Same pin as Lab 07: `@earendil-works/pi-agent-core@0.85.1`. Everything below was
reverse-engineered from `node_modules/@earendil-works/pi-agent-core/dist/harness/**/*.d.ts`
and, for the recovery mechanism specifically, from **reading the raw JSONL a real crash left
behind** — none of this is documented in the package's own `README.md`, and some of it (the
tool-call replay policy) is not exposed through any public type either.

- `AgentHarness.create(...)` returns `{ harness, open }` where `open: OpenOperation[]` is
  `{ lane, operationId, kind, startedAt, aborting? }` for every lane whose last operation
  never settled. Lab 07 always saw `open: []`; this lab is the first time it is non-empty.
- `lane.resume(context)` returns `ResumeResult = Result<OperationResultRecord | SuspendedRun,
  NothingToResume | Closed>`. `NothingToResume` is a distinct, typed, `TaggedErrorValue` — not
  a status field to check on success, an actual rejection branch of the `Result`.
- Every lane-scoped `HarnessEvent` can carry `recovery?: true`. It is set on events emitted
  while the harness is catching up to already-durable state (draining a completed tool
  outcome, re-emitting a `turn_start` for a turn that had already begun) rather than producing
  something for the first time. This lab's trace logger prints it explicitly.
- The harness's own operation state machine (**not** documented in any `.d.ts` — found by
  reading the raw JSONL, see section 5) tracks each in-flight tool call's status as
  `"planned" -> "effect_pending" -> "outcome_ready" -> "completed"`, and `"effect_pending"`
  carries a `replay: "never" | "safe"` field. When a process dies with a call parked at
  `"effect_pending"`/`replay: "never"`, `resume()` does **not** re-invoke the tool and does
  **not** wait for it — it synthesizes a durable `toolResult` entry itself:
  `isError: true`, content `"[Tool execution was interrupted. The preceding output is the
  latest durable progress snapshot; newer live output may be missing, and the external
  outcome is unknown.]"` — and then lets the model continue the conversation from that fact.
  This lab's fixture tool never declares itself replay-safe, so this lab only ever observes
  the `"never"` path. Whether a tool *can* declare itself `"safe"`, and what changes if it
  does, is explicitly Lab 09's question, not this one's — treat this paragraph as the
  documented starting point for that lab, not as this lab's own finding to re-derive.

## 1. Predict before running

Record your predictions in writing before installing dependencies or reading further. This
lab's recorded prediction (verbatim):

> 1. user message is already durable
> 2. recover the state
> 3. tip ID stay stable
> 4. replay the cached result

Section 4 below runs the real experiment and compares these four answers against what
actually happened, entry by entry — do not skip ahead to it before writing your own answer if
you are doing this lab yourself.

## 2. Install dependencies

```bash
cd lab-08-crash-recovery
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

## 3. Verify the deterministic parts

```bash
npm run check
```

This is `tsc --noEmit` plus Vitest across seven files: the booking and container-event
repositories, both harness tools, `modelSelectionFromEnvironment` /
`slowToolDelayMsFromEnvironment`, `openOrCreateSession`'s lifecycle, and the Lab-07-style
deterministic `Session -> AgentHarness -> lane` durability test (using `lane.appendMessage()`
directly, no model or network access).

One test is worth reading closely —
`tests/slow-container-events-tool.test.ts`'s first case proves, without any process spawning,
that the tool's checkpoint fires **synchronously**, before its returned promise can possibly
have settled:

```ts
const promise = tool.execute("call-1", { containerNo: "MSKU1234567" }, ...);
// execute() only reached its first `await` — the checkpoint already fired here.
expect(dispatched).toEqual(["call-1"]);
```

This is the deterministic half of the failure injection's premise. What it cannot prove
without a real model is that the *assistant's tool-call message* is durable by the time this
checkpoint fires — only a live run settles that, which is what section 4 is for.

Everything in this section is model-free and network-free. Nothing here spawns a process or
kills one — that is `scripts/crash-recovery-demo.ts`, next.

## 4. Run the crash-recovery demo (live evidence)

```bash
npm run demo:crash -- --session conversation-crash-a
```

This is the roadmap's "deterministic parent test harness that waits for a named checkpoint
before terminating the child process." It never sleeps to guess timing: it spawns a child
running `npm run agent -- --session ... --prompt "..."`, watches its stdout line by line, and
sends `SIGKILL` the instant it sees `[Checkpoint] tool_dispatched` — then spawns two more
child processes (`--resume`, then `--resume` again) and asserts on their output. It exits
non-zero if any assertion fails.

Actual output from one recorded run (trimmed to the load-bearing lines; ids are unique per
run — the shape, the `↺` recovery markers, and the `NothingToResume` line are what to compare
against your own run). `src/harness-trace-logger.ts` renders `harness.events` as an indented
run/turn/tool tree — `▶`/`◀` mark a span opening/closing, `↺` marks an event fired while the
harness is catching up to durable state during recovery. Notice step 2's recovery block jumps
straight from `↺ ▶ turn` to a synthesized `↺ ◀ tool_end` with **no** `↺ ▶ tool_start` in
between — the tool was never actually re-invoked:

```text
=== Step 1: start a turn that will be killed mid-flight (session=conversation-crash-a) ===
[child:stdout] [Session] id=conversation-crash-a created path=.../conversation-crash-a.jsonl
[child:stdout] [Harness] lane=main openOperationsOnAttach=0
[child:stdout] [User][conversation-crash-a] What are the movement events for container MSKU1234567?
[child:stdout] ▶ run 01a0b1f5-6566-...
[child:stdout]   user      "What are the movement events for container MSKU1234567?" entry=01a0b1f5-6566-...
[child:stdout]   ▶ turn 01a0b1f5-6569-...
[child:stdout]     assistant (tool call only, no text) entry=01a0b1f5-656a-...
[child:stdout]     ▶ tool_start get_container_events call=call_00_QOnLI... args={"containerNo":"MSKU1234567"}
[child:stdout] [Checkpoint] tool_dispatched toolCallId=call_00_QOnLI... tool=get_container_events containerNo=MSKU1234567
[demo] turn 1 exited: code=null signal=SIGKILL

=== Step 2: reopen and resume the interrupted operation (session=conversation-crash-a) ===
[child:stdout] [Session] id=conversation-crash-a reopened path=... (same file)
[child:stdout] [Harness] lane=main openOperationsOnAttach=1
[child:stdout] [Harness] lane=main OPEN operation=01a0b1f5-6566-... kind=run startedAt=1789692044646
[child:stdout] [Lane] entries(before)=2
[child:stdout] [Entry][before] seq=4  ... type=message role=user
[child:stdout] [Entry][before] seq=30 ... type=message role=assistant
[child:stdout] [Resume][conversation-crash-a] inspecting open operation before calling lane.resume()
[child:stdout] ↺ ▶ turn 01a0b1f5-6569-...
[child:stdout]   ↺ ◀ tool_end get_container_events status=error
[child:stdout]   ↺ toolResult get_container_events status=error entry=01a0b1f5-656a-...
[child:stdout] ↺ ◀ turn_end tool_results=1
[child:stdout] ▶ turn 01a0b1f5-6a89-...
[child:stdout]   [Assistant] entry=01a0b1f5-6a8a-... The lookup for container MSKU1234567 was interrupted before any events were returned, so I don't have its movement history yet. Want me to try again?
[child:stdout] ◀ turn_end tool_results=0
[child:stdout] ◀ run_end status=completed fromTip=null tip=01a0b1f5-6a8a-...
[child:stdout] [Resume] operationId=01a0b1f5-6566-... kind=run status=completed fromTip=null tip=01a0b1f5-6a8a-...
[child:stdout] [Lane] entries(after)=4
[demo] resume 1 exited: code=0 signal=null

=== Step 3: resume again after settlement (session=conversation-crash-a) ===
[child:stdout] [Harness] lane=main openOperationsOnAttach=0
[child:stdout] [Resume][conversation-crash-a] inspecting open operation before calling lane.resume()
[child:stdout] [Resume] rejected: NothingToResume: Lane "main" has no active operation to resume
[child:stdout] [Lane] entries(after)=4
[demo] resume 2 exited: code=0 signal=null

=== All Lab 08 crash-recovery assertions passed ===
```

### Predictions vs. evidence

| # | Prediction | What actually happened |
| - | ---------- | ----------------------- |
| 1 | "user message is already durable" | True, but incomplete: the **assistant's tool-call message** (entry `seq=30`) is also durable by the checkpoint — in fact the operation's admission (`pi.op.meta`/`pi.op.state`, `seq=6-7`) is durable *before the model is even called*, well before either message. |
| 2 | "recover the state" | `resume()` does not restore the tool's output — it cannot, the tool never reported one. It marks the parked call as failed with a specific synthesized message and lets the model continue from that fact. "Recovering" here means reaching a terminal result, not reconstructing the missing answer. |
| 3 | "tip ID stay stable" | False. The tip **advanced** across the crash (`seq=30` before resume -> `seq=88` after — two new entries: the synthesized tool-result and a new assistant message). What actually stayed stable across the crash was the **`operationId`** (`...c8af5ca1ef22`, identical in the `OPEN operation=` line and the final `[Resume] operationId=` line). |
| 4 | "replay the cached result" (2nd resume) | False — there is no cached result to replay. The 2nd `resume()` call returns the typed error `NothingToResume`, an explicit terminal rejection, not a replay of anything and not a repeat of the first call's work. |

The corrected mental model: a crash never loses anything that was already committed (the user
message, the assistant's tool-call request, the operation's own admission record). What it
loses is exactly the tool's *pending, uncommitted outcome* — and the harness's answer to that
loss is not "guess" or "wait forever", it is "fail that one call explicitly, keep the
conversation moving." `resume()` on an already-settled operation is not a no-op that quietly
succeeds again; it is a distinct, named, terminal condition (`NothingToResume`).

## 5. Inspect the JSONL evidence directly

```bash
find session-data -name '*.jsonl' | sort
```

Read the raw file for the session you just ran (`cat` it, or pipe each line through
`python3 -m json.tool` — commit lines are JSON *arrays*, see Lab 07 section 5 for the format).
Confirm by eye:

- **The operation is durable almost immediately, not just "by the time the tool runs".**
  Two commits after the user entry (`seq=4`), `pi.op.meta` and `pi.op.state` (`seq=6`,
  `seq=7`) already record the operation with `intent.kind: "run"` and `control.status:
  "running"` — before the model has produced a single token.
- **The last write the killed process ever made** sets `pi.op.state.at` to `"tools"` with
  `batch.calls[0]` = `{ "status": "effect_pending", "sourceIndex": 0, "resultEntryId": "...",
  "replay": "never" }`. This is the exact durable fact `resume()` reads on reopen — not the
  tool's args, not a partial output, just "this call was dispatched and never settled, and it
  is not safe to silently redo."
- **The synthesized recovery entry**, written by the *resume* process, not the original one:
  a `toolResult` message entry with `isError: true` and the fixed text `"[Tool execution was
  interrupted. The preceding output is the latest durable progress snapshot; newer live
  output may be missing, and the external outcome is unknown.]"`. Nothing in this file
  contains the real container-events payload for this run — the crash genuinely lost that
  specific piece of information, permanently; the harness's job was never to recover it, only
  to stop the conversation from hanging on it forever.
- **Two entirely disjoint sets of `seq` numbers** on either side of the crash: everything
  through `seq=36` was written by the process that got `SIGKILL`ed; `seq=37` onward was
  written by a separate process minutes (or, in your run, however long) later, reading the
  same file from disk. No `seq` is duplicated, and no entry from before the crash is rewritten
  — only appended after.

Do not hand-edit these files. Delete `session-data/` and rerun `npm run demo:crash` for a
fresh, fully reproducible crash if you want to inspect a run of your own.

## 6. Explain the trace

Answer using your own terminal output and JSONL files:

1. What is the earliest point in the JSONL file at which the operation admitted by your
   prompt becomes durable? Is it before or after the assistant has said anything at all?
2. `resume()` printed `↺ ◀ tool_end ... status=error` with no matching `↺ ▶ tool_start` before
   it, for a tool that, from the killed process's point of view, never got the chance to
   fail. Where did that error come from, and which process actually wrote it to disk?
3. Compare the `operationId` printed in `[Harness] lane=main OPEN operation=...` (step 2) to
   the `operationId` in the final `[Resume] operationId=...` line. What does that equality
   prove, and which id (if any) would you expect to differ if the harness instead started a
   brand new operation to recover?
4. The second `--resume` call is not an error in the everyday sense — the CLI exits `0` for
   it. Why does this lab treat `NothingToResume` as success rather than failure, and what
   would it mean for this lab's completion criteria if a second resume instead silently
   repeated the first one's tool call?
5. Was your original prediction right? Write the corrected explanation in your own words,
   specifically calling out what "durable" turned out to mean for a tool call in progress
   versus for a completed message.

## Completion criteria

- `npm run check` passes: seven test files, booking/container-event repositories, both
  harness tools (including the checkpoint-before-completion ordering test), model/delay
  environment parsing, session lifecycle, and the Lab-07-style deterministic durability test.
- `npm run demo:crash` passes its own assertions on a live run: the first invocation is
  killed by `SIGKILL` exactly at the `tool_dispatched` checkpoint and never produces a final
  assistant answer; the first `--resume` discovers exactly the interrupted operation and
  drives it to `status=completed`; the second `--resume` reports `NothingToResume` instead of
  repeating any work.
- The interrupted session reopens with no manual JSONL repair — `openOrCreateSession` and
  `AgentHarness.create()` are the only recovery code this lab writes; everything else is the
  package's own `resume()`.
- Exactly one user entry (`seq=4`) exists in the final transcript — recovery never appended a
  second prompt.
- You can distinguish, from evidence rather than from this README, "reopening a completed
  session" (Lab 07 — `open: []` every time) from "resuming an open operation" (this lab —
  `open` non-empty exactly once, until the first successful `resume()`).
- You can state what a `"never"`-replay tool call's crash outcome actually is (a synthesized,
  explicit `isError: true` result — not a retry, not data loss silently ignored) without
  needing to know yet how a `"safe"`-replay tool would differ; that comparison is Lab 09's.

## Project map

```text
src/booking-repository.ts          Lab 07's fixture repository (own copy)
src/get-booking-tool.ts            Lab 07's fast, quick-return harness tool (own copy)
src/container-event-repository.ts  Lab 04's fixture repository, adapted (own copy)
src/slow-container-events-tool.ts  New: intentionally slow harness tool with a printed
                                    dispatch checkpoint — this lab's whole failure surface
src/checkpoint.ts                  Shared marker format between the tool (writer) and the
                                    demo script (reader) — no timing, no sleeps, just a string
src/session-store.ts               JsonlSessionRepo wiring + create-or-reopen-by-id helper
src/create-harness.ts              Model selection + both tools + AgentHarness.create()
src/harness-trace-logger.ts        Indented run/turn/tool tree logger, `↺` marks recovery
src/cli.ts                         One invocation = one turn (--prompt) or one resume
                                    attempt (--resume) against one named session
scripts/crash-recovery-demo.ts     Deterministic parent harness: spawn, watch for the
                                    checkpoint, SIGKILL, resume, resume again, assert
data/bookings.json                 Same fixture as Lab 05/07
data/container-events.json         Same fixture as Lab 04
session-data/                      Durable JSONL sessions this lab writes (git-ignored)
tests/                             Deterministic tests — no network calls anywhere
```

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider connection issues — they
apply unchanged here, including the `--use-env-proxy` requirement baked into `npm run agent`
and `npm run demo:crash`.

If `npm run demo:crash` never sees the checkpoint and hangs, the model chose not to call
`get_container_events` at all (check the mirrored `[child:stdout]` lines for what it did call)
— rerun; the system prompt makes this call close to deterministic for the fixed demo prompt,
but no live model call is guaranteed word for word.

If a resume step reports `openOperationsOnAttach=0` when you expected `1`, a previous
`npm run demo:crash` run against the same `--session` id already resolved that operation —
either pick a fresh session id or delete `session-data/` and start over.
