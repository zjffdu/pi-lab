# Lab 09 — Tool Replay Safety

Lab 08 killed a process mid tool-call and showed that `resume()` never repeats the call —
it synthesizes an explicit `isError: true` result instead. That lab's fixture tool never
declared its own replay policy, so it only ever exercised Pi's *default*. This lab makes the
policy an explicit, contrasted choice: one read-only tool that opts into `replay: "safe"`
(recovery may genuinely re-run it), and one state-changing tool that stays `replay: "never"`
(recovery must not). Both get killed mid-flight, on purpose, at a different named checkpoint
each — and this lab counts, with local evidence Pi itself never sees, exactly how many times
each tool's `execute()` actually ran.

## Learning objective

By the end of this lab, you can explain this from your own console output and evidence files:

```text
durable tool intent
  -> effect outcome known       -> commit result
  -> effect outcome unknown
       -> replay: "safe"        -> recovery calls execute() again, for real
       -> replay: "never"       -> recovery synthesizes an interrupted result, no re-call

application idempotency
  !=
Pi replay policy
```

This lab extends [Lab 08](../lab-08-crash-recovery/README.md)'s `Session -> AgentHarness ->
lane("main")` stack with two new tools, replacing Lab 08's single always-`"never"` fixture. It
does **not** cover real notifications, bookings, or APIs; provider retry policy or HTTP retry
behavior; exactly-once claims across systems Pi does not control; or production outbox
delivery and distributed transaction protocols — this lab's only "external side effect" is a
local, append-only JSON-lines file this lab itself owns and resets.

## Vocabulary (read before predicting)

- **Replay policy** (`tool.replay: "never" | "safe"`) — a field on the tool definition
  itself, not on any one call. `"never"` is the default when a tool leaves it undeclared
  (this is what Lab 08's fixture tool did). It answers one question only: *if a process dies
  after this call's durable intent is committed but before its outcome is committed, is it
  safe for recovery to call `execute()` again?*
- **Invocation** (`AgentHarnessToolInvocation`) — the harness's own stable identity for one
  logical tool call: `invocationId`, `operationId`, `turnId`, plus `getMemo`/`setMemo` for
  invocation-scoped durable bookkeeping. Per its own type comment, `invocationId` is
  "unchanged during safe replay" — this lab checks that claim directly instead of taking it
  on faith.
- **Attempt** (this lab's own vocabulary, not Pi's) — one real call to a tool's `execute()`.
  `src/attempt-log.ts` records one line per attempt, synchronously, before any `await` inside
  `execute()` — deliberately independent of anything Pi's own session ever commits. The whole
  point of this lab is that "attempts" and "committed tool-result entries" can diverge in
  both directions, and neither one is redundant with the other.
- **Effect** (this lab's own vocabulary) — one append to `src/outbox-repository.ts`'s local
  JSON-lines file, written synchronously by `request_booking_hold` the instant its (fake,
  local) business action has "happened" — before that call's artificial post-effect delay,
  before its result is committed. This is the file whose entry count either does or does not
  match its attempt count.
- **Application idempotency vs. Pi replay policy** — two different layers with two different
  jobs. Pi's replay policy only decides whether *Pi itself* calls `execute()` a second time.
  Whether that second call is *safe to have happen twice in the world* is the tool
  implementation's own responsibility — declaring `replay: "safe"` on a tool whose effect is
  not naturally idempotent would not make it safe, it would just make Pi duplicate it
  automatically instead of never touching it again.

## Prerequisites

- Node.js 24.5 or newer
- npm
- Credentials for a model provider supported by `@earendil-works/pi-ai`

The default configuration uses DeepSeek V4 Flash through the official DeepSeek API, same as
every earlier lab.

## API note (revalidated against the pinned version)

Same pin as Labs 07-08: `@earendil-works/pi-agent-core@0.85.1`. Reverse-engineered from
`node_modules/@earendil-works/pi-agent-core/dist/harness/**/*.d.ts` and, for the two branches
below specifically, from `dist/harness/runtime/drive/tools.js` — the actual recovery
dispatch, not documented in any `.d.ts`.

- `AgentTool.replay?: "never" | "safe"` (inherited by `AgentHarnessTool`). Undeclared reads
  as `"never"` — `tools.js`'s `publishToolIntent(...)` call uses
  `prepared.cleared.tool.replay ?? "never"` verbatim.
- On recovery, `recoverToolInvocation(...)` branches on `call.replay === "safe" && tool?.replay
  === "safe"` (the call's own durably recorded policy **and** the currently loaded tool's
  policy must agree — not just the tool's).
  - **`"safe"`**: it clears the call's durable replay checkpoint and calls `execute()` again —
    a real second invocation, with the *same* `toolCall` object recovered from the durable
    entries, not a freshly minted one. Only the invocation that finishes writes a committed
    result.
  - **Anything else (including undeclared/`"never"`)**: it reads the last durable checkpoint
    for that call and publishes a synthesized `interruptedOutcome` — `execute()` is never
    called again. This is exactly Lab 08's finding, restated as the `else` branch of the same
    function the `"safe"` path lives in.
- `AgentHarnessToolInvocation.invocationId` is "opaque session-unique id equal to the call's
  reserved result-entry id" per its own type comment — this lab checks that it is identical
  across a safe tool's two real attempts, and that it is the value threaded into the local
  outbox record for the never tool's one attempt.

## 1. Predict before running

Record your predictions in writing before installing dependencies or reading further. This
lab's recorded prediction (verbatim, written before section 4 was run):

> 1. Under `"safe"` replay, recovery calls the tool again, but the *model* still trusts
>    whatever partial description it saw before the crash instead of the fresh result.
> 2. Under `"never"` replay, recovery silently retries anyway, because retrying is the safer
>    default when the outcome is unknown.
> 3. The `invocationId` changes between the two real attempts of the safe tool, because each
>    real `execute()` call is, from the tool's point of view, a new attempt.
> 4. Preventing a duplicated business effect is entirely the tool implementation's job — Pi
>    itself has no opinion and will call a `"safe"` tool as many times as recovery needs to.

Section 4 below runs the real experiment and compares these four answers against what
actually happened. Do not skip ahead to it before writing your own answer if you are doing
this lab yourself.

## 2. Install dependencies

```bash
cd lab-09-tool-replay-safety
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

## 3. Verify the deterministic parts

```bash
npm run check
```

This is `tsc --noEmit` plus Vitest across the booking and container-event repositories, the
checkpoint format, the local attempt-log and outbox fixtures, both harness tools (including
the checkpoint-ordering tests below), model/delay/evidence-path environment parsing, session
lifecycle, and the Lab-07/08-style deterministic durability test.

Two tests are worth reading closely:

- `tests/get-container-events-safe-tool.test.ts`'s ordering test proves the dispatch
  checkpoint and the attempt-log write both happen **synchronously**, before `execute()`'s
  returned promise can possibly have settled — the same premise Lab 08 proved for its own
  slow tool.
- `tests/request-booking-hold-tool.test.ts`'s ordering test proves a stricter sequence: the
  outbox append happens *before* the `effect_appended` checkpoint, which happens *before* the
  post-effect delay resolves. This is the exact window the failure injection below kills
  inside — after the effect is durable on disk, before Pi's result is committed.

Everything in this section is model-free and network-free. Nothing here spawns a process or
kills one — that is `scripts/replay-safety-demo.ts`, next.

## 4. Run the replay-safety demo (live evidence)

```bash
npm run demo:replay
```

Two independent scenarios run back to back, each its own fresh session id and its own fresh
local evidence files under `runtime-evidence/`:

- **Safe scenario** — prompts for `get_container_events`, kills the child the instant it sees
  `[Checkpoint] tool_dispatched ... tool=get_container_events` (same moment Lab 08 killed at),
  then resumes twice.
- **Never scenario** — prompts `request_booking_hold`, kills the child the instant it sees
  `[Checkpoint] effect_appended ... tool=request_booking_hold` — deliberately later than
  dispatch, because this tool's interesting failure window opens only after its local effect
  is already durable — then resumes twice.

Actual output from one recorded run (trimmed to the load-bearing lines; ids are unique per
run — the shape, the `recovery=true` tags, and the checkpoint ordering are what to compare
against your own run):

```text
########## Scenario: safe replay (get_container_events) ##########

=== Step 1: start a turn that will be killed mid-flight ===
[child:stdout] [Harness] lane=main openOperationsOnAttach=0
[child:stdout] [User] What are the movement events for container MSKU1234567?
[child:stdout] [Assistant] I'll look up the movement events for that container.
[child:stdout] [Harness] lane=main tool_start tool=get_container_events call=call_00_4utub...
[child:stdout] [Checkpoint] tool_dispatched toolCallId=call_00_4utub... tool=get_container_events containerNo=MSKU1234567
[demo] turn 1 exited: code=null signal=SIGKILL

=== Step 2: reopen and resume the interrupted operation ===
[child:stdout] [Harness] lane=main openOperationsOnAttach=1
[child:stdout] [Harness] lane=main OPEN operation=01a0ae85-65a6-...
[child:stdout] [Harness] lane=main turn_start ... recovery=true
[child:stdout] [Harness] lane=main tool_start tool=get_container_events call=call_00_4utub... recovery=true
[child:stdout] [Checkpoint] tool_dispatched toolCallId=call_00_4utub... tool=get_container_events containerNo=MSKU1234567
[child:stdout] [Harness] lane=main tool_end tool=get_container_events call=call_00_4utub... status=success recovery=true
[child:stdout] [Assistant] Movement events for **MSKU1234567** (oldest first): ... GATE_IN, LOAD, DEPARTURE ...
[child:stdout] [Resume] operationId=01a0ae85-65a6-... status=completed fromTip=null tip=01a0ae85-a678-...
[demo] resume 1 exited: code=0 signal=null

=== Step 3: resume again after settlement ===
[child:stdout] [Harness] lane=main openOperationsOnAttach=0
[child:stdout] [Resume] rejected: NothingToResume: Lane "main" has no active operation to resume
[demo] resume 2 exited: code=0 signal=null
[demo] safe replay (get_container_events): attempts=2 outbox=0

########## Scenario: never replay (request_booking_hold) ##########

=== Step 1: start a turn that will be killed mid-flight ===
[child:stdout] [User] Please place a hold on booking BK1001 for "customs review" and tell me the hold id.
[child:stdout] [Assistant] I'll place the hold on BK1001 for customs review.
[child:stdout] [Harness] lane=main tool_start tool=request_booking_hold call=call_00_GcpXa...
[child:stdout] [Checkpoint] tool_dispatched toolCallId=call_00_GcpXa... tool=request_booking_hold bookingNo=BK1001
[child:stdout] [Checkpoint] effect_appended toolCallId=call_00_GcpXa... tool=request_booking_hold bookingNo=BK1001 holdId=hold-01a0ae85-b0bb-...
[demo] turn 1 exited: code=null signal=SIGKILL

=== Step 2: reopen and resume the interrupted operation ===
[child:stdout] [Harness] lane=main openOperationsOnAttach=1
[child:stdout] [Harness] lane=main OPEN operation=01a0ae85-b0b8-...
[child:stdout] [Harness] lane=main turn_start ... recovery=true
[child:stdout] [Harness] lane=main tool_end tool=request_booking_hold call=call_00_GcpXa... status=error recovery=true
[child:stdout] [Assistant] The hold request for BK1001 ("customs review") was interrupted mid-execution, so the
outcome is unknown — I can't confirm whether the hold was actually placed, and no hold id
was returned. Per policy, I won't re-run it for this same request, since repeating a
state-changing call could create a duplicate hold.
[child:stdout] [Resume] operationId=01a0ae85-b0b8-... status=completed fromTip=null tip=01a0ae85-b720-...
[demo] resume 1 exited: code=0 signal=null

=== Step 3: resume again after settlement ===
[child:stdout] [Resume] rejected: NothingToResume: Lane "main" has no active operation to resume
[demo] resume 2 exited: code=0 signal=null
[demo] never replay (request_booking_hold): attempts=1 outbox=1

########## Evidence summary ##########
┌─────────┬────────────────────────┬─────────┬──────────┬─────────┬──────────────────┬─────────────────────────────────────────────────────────────────────┐
│ (index) │ tool                   │ replay  │ attempts │ effects │ committedResults │ note                                                                │
├─────────┼────────────────────────┼─────────┼──────────┼─────────┼──────────────────┼─────────────────────────────────────────────────────────────────────┤
│ 0       │ 'get_container_events' │ 'safe'  │ 2        │ 0       │ 1                │ 're-invoked once on recovery; only 1 result ever commits'           │
│ 1       │ 'request_booking_hold' │ 'never' │ 1        │ 1       │ 1                │ 'recovery synthesizes an interrupted result instead of re-invoking' │
└─────────┴────────────────────────┴─────────┴──────────┴─────────┴──────────────────┴─────────────────────────────────────────────────────────────────────┘

=== All Lab 09 tool-replay-safety assertions passed ===
```

Raw `runtime-evidence/*.jsonl` from that same run:

```text
attempts-safe.jsonl:
{"tool":"get_container_events","toolCallId":"call_00_4utub...","invocationId":"01a0ae85-65aa-...-8bd41914e60b","detail":"MSKU1234567","at":1789634374116}
{"tool":"get_container_events","toolCallId":"call_00_4utub...","invocationId":"01a0ae85-65aa-...-8bd41914e60b","detail":"MSKU1234567","at":1789634374605}
outbox-safe.jsonl: (file does not exist — zero effects)

attempts-never.jsonl:
{"tool":"request_booking_hold","toolCallId":"call_00_GcpXa...","invocationId":"01a0ae85-b0bb-...-3500929e14bf","detail":"BK1001","at":1789634393349}
outbox-never.jsonl:
{"invocationId":"01a0ae85-b0bb-...-3500929e14bf","bookingNo":"BK1001","reason":"customs review","holdId":"hold-01a0ae85-b0bb-...-3500929e14bf","at":1789634393350}
```

The two safe-scenario attempts share one `invocationId` and one `toolCallId` — the
`AgentHarnessToolInvocation.invocationId` type comment's claim ("unchanged during safe
replay") checked out directly. The never-scenario's single attempt and its one outbox record
share one `invocationId` too — that shared id is what actually lets you prove, after the
fact, which attempt produced which effect.

Directly from the session JSONL's `pi.op.state` records (`python3 -m json.tool` on each
commit line, filtered to `namespace: "pi.op.state"`), both scenarios' tool-call batch entry
passed through the identical transition shape, differing only in the durable `replay` field:

```text
safe:  {"status":"planned", ...}
    -> {"status":"effect_pending","replay":"safe", ...}   <- killed process's last write
    -> {"status":"outcome_ready", ...}                     <- written by the RESUME process,
                                                                after a second real execute()

never: {"status":"planned", ...}
    -> {"status":"effect_pending","replay":"never", ...}  <- killed process's last write
    -> {"status":"outcome_ready", ...}                     <- written by the RESUME process,
                                                                with NO second execute() call
```

### Predictions vs. evidence

| # | Prediction | What actually happened |
| - | ---------- | ----------------------- |
| 1 | "the model still trusts whatever partial description it saw before the crash instead of the fresh result" | False, and there was no partial description to trust — the model saw no tool output at all before the crash (it had only just dispatched the call). For the safe tool, the model's final answer used the *fresh*, complete result from the second real `execute()` call — a normal table of movement events, not a hedge. |
| 2 | "under `\"never\"` replay, recovery silently retries anyway" | False. `attempts-never.jsonl` has exactly one line. The assistant's own recovered answer states this directly, unprompted: *"Per policy, I won't re-run it for this same request, since repeating a state-changing call could create a duplicate hold."* — the model correctly inferred the reason from the synthesized interrupted result, it did not need to be told. |
| 3 | "the `invocationId` changes between the two real attempts of the safe tool" | False. Both attempt-log lines for the safe tool carry the identical `invocationId` (and the identical `toolCallId`) — recovery reconstitutes and replays the *same* logical call; it does not mint a new one. |
| 4 | "preventing a duplicated business effect is entirely the tool implementation's job — Pi has no opinion" | Half right, half backwards. Pi *does* have an opinion — it is exactly what `tool.replay` declares, and Pi enforces it (zero re-invocations for `\"never\"`, real re-invocation for `\"safe\"`). What is genuinely the tool implementation's job is making sure that opinion is *true*: `get_container_events` is safe to re-run only because reading twice has no effect on the world. Had `request_booking_hold` been declared `\"safe\"` without being idempotent, Pi would have happily called it — and appended — a second time. |

The corrected mental model: `replay` is Pi's own declared contract with itself, not a hint the
tool implementation can ignore or override at the effect layer. Getting it right is a joint
responsibility — Pi enforces whichever policy is declared, but only the tool author knows
whether the tool's real-world effect can actually tolerate being asked twice.

## 5. Inspect the evidence directly

```bash
find session-data -name '*.jsonl' | sort
cat runtime-evidence/attempts-safe.jsonl
cat runtime-evidence/outbox-safe.jsonl
cat runtime-evidence/attempts-never.jsonl
cat runtime-evidence/outbox-never.jsonl
```

Confirm by eye:

- **`attempts-safe.jsonl` has two lines, `outbox-safe.jsonl` has none.** Both attempt lines
  share the same `invocationId` and the same `toolCallId` — recovery replayed the one logical
  call, it did not start a second one. Only one committed `toolResult` entry for that call
  exists in the session's own JSONL, even though `execute()` genuinely ran twice — this is
  the gap between "attempts" and "committed results" the roadmap asks you to be able to
  count.
- **`attempts-never.jsonl` has exactly one line, `outbox-never.jsonl` has exactly one line,**
  and they share one `invocationId`. The process was killed *after* the outbox entry already
  existed on disk; recovery still did not call `execute()` again. The business effect that
  really happened is on disk exactly once — not because the tool checked for a duplicate, but
  because Pi never asked it to run twice.
- **The session JSONL's own `pi.op.state` entry for the never call** ends at
  `"effect_pending"` with `replay: "never"`, the same shape Lab 08 found — and the entry the
  *resume* process writes for it is a synthesized `isError: true` `toolResult`, not the real
  `{"holdId": ..., "status": "requested"}` payload the tool actually returned to nobody (the
  process was already dead by the time `execute()`'s promise would have settled).
- **The session JSONL's own `pi.op.state` entry for the safe call**, by contrast, shows the
  batch call transition through a second `"effect_pending"` -> `"outcome_ready"` cycle after
  the resume — direct durable evidence of the second real invocation, not just this lab's own
  attempt log.

Do not hand-edit these files. Delete `session-data/` and `runtime-evidence/` and rerun `npm
run demo:replay` for a fresh, fully reproducible pair of runs.

## 6. Explain the trace

Answer using your own terminal output and evidence files:

1. Both scenarios print `[Harness] lane=main OPEN operation=...` on their first resume. What
   is different about what happens *next* for the safe call versus the never call, and where
   in `tools.js`'s `recoverToolInvocation` does that difference actually get decided?
2. `attempts-safe.jsonl` has two lines with the same `invocationId`. What would it mean —
   for correctness, not just for this lab's assertions — if the second attempt instead got a
   *new* `invocationId`? Which of this lab's tools would that be dangerous for, and why is it
   not dangerous for the one that actually has it happen?
3. The never scenario's outbox entry exists *before* the process is killed. Was the booking
   hold "requested" from the business's point of view at that moment, even though the caller
   (the assistant, and the user) never received confirmation? What does that imply about
   `replay: "never"` as a *safety* property versus a *correctness* property?
4. If `request_booking_hold` were changed to declare `replay: "safe"` without changing its
   implementation, predict what `outbox-never.jsonl` would look like after the same kill
   point. Why would that be a bug in the tool's replay declaration, not in Pi's recovery
   logic?
5. Was your original prediction right? Write the corrected explanation in your own words,
   specifically calling out what "safe" turned out to mean (recovery may re-run a call) versus
   what it did not mean (recovery does not make a tool's own effect idempotent).

## Completion criteria

- `npm run check` passes: repositories, checkpoint format, attempt-log and outbox fixtures,
  both harness tools (including their checkpoint-ordering tests), environment parsing, and
  the deterministic durability test.
- `npm run demo:replay` passes its own assertions on a live run for both scenarios: each first
  invocation is killed by `SIGKILL` at its own named checkpoint; each first `--resume`
  discovers exactly its interrupted operation and drives it to `status=completed`; each second
  `--resume` reports `NothingToResume`.
- The safe tool's recovery behavior is visible and evidence-backed: `attempts-safe.jsonl` has
  exactly 2 lines sharing one `invocationId` and one `toolCallId`.
- The non-replayable tool is not invoked a second time after an unknown outcome:
  `attempts-never.jsonl` has exactly 1 line.
- The local outbox contains no duplicated business effect: `outbox-never.jsonl` has exactly 1
  line, and its `invocationId` matches the single attempt that produced it.
- You can distinguish replay safety (does Pi call `execute()` again), retry (a provider- or
  application-level decision this lab never makes), and application idempotency (whether a
  repeated real-world effect would be safe) as three separate concerns.
- The README avoids claiming universal exactly-once execution anywhere across the outbox,
  the session JSONL, or the attempt log.

## Project map

```text
src/booking-repository.ts              Lab 07/08's fixture repository (own copy)
src/container-event-repository.ts      Lab 04/08's fixture repository (own copy)
src/checkpoint.ts                      Shared marker format, extended with a second
                                        checkpoint name and structured field parsing
src/attempt-log.ts                     Local, synchronous "execute() really ran" evidence —
                                        independent of anything Pi itself commits
src/outbox-repository.ts               Local, synchronous "the business effect really
                                        happened" evidence — this lab's only side effect
src/get-container-events-safe-tool.ts  New: read-only, declares replay: "safe"
src/request-booking-hold-tool.ts       New: state-changing, declares replay: "never",
                                        effect = one outbox append
src/session-store.ts                   JsonlSessionRepo wiring + create-or-reopen-by-id
src/create-harness.ts                  Model selection + both tools + AgentHarness.create()
src/harness-trace-logger.ts            Lifecycle logging (unchanged from Lab 08)
src/cli.ts                             One invocation = one turn (--prompt) or one resume
                                        attempt (--resume) against one named session
scripts/replay-safety-demo.ts          Deterministic parent harness: two scenarios, each
                                        spawn/watch-checkpoint/SIGKILL/resume/resume/assert
data/bookings.json                     Same fixture as Lab 05/07/08
data/container-events.json             Same fixture as Lab 04/08
session-data/                          Durable JSONL sessions this lab writes (git-ignored)
runtime-evidence/                      Attempt-log and outbox JSON-lines files this lab
                                        writes and resets on every demo run (git-ignored)
tests/                                 Deterministic tests — no network calls anywhere
```

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider connection issues — they
apply unchanged here, including the `--use-env-proxy` requirement baked into `npm run agent`
and `npm run demo:replay`.

If `npm run demo:replay` never sees a scenario's checkpoint and hangs, the model chose not to
call the expected tool for that scenario's prompt (check the mirrored `[child:stdout]` lines
for what it called instead) — rerun; the system prompt makes each call close to deterministic
for its fixed demo prompt, but no live model call is guaranteed word for word.

If a resume step reports `openOperationsOnAttach=0` when you expected `1`, a previous `npm run
demo:replay` run already resolved that operation under the same session id — the script mints
a fresh timestamped id on every run, so this should only happen if you re-run a `--resume`
manually against an old `--session` value.
