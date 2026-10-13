# Lab 09 — Tool Replay Safety

English | [中文](README.zh-CN.md)

**Question:** when a process dies after a tool call may already have changed something, may Pi run that tool again?
**Answer this lab shows:** it depends on one word the tool author declares, and Pi trusts it without checking.

- **`replay: "safe"`** — recovery runs `execute()` again. The call keeps its task id and call id, and one real result is committed.
- **`replay: "unsafe"`** (the default) — recovery does not enter `execute()`. It commits an `interrupted` error result instead.

`"unsafe"` protects you from running a call twice. It does not tell you whether the first run happened: `interrupted` means
*outcome unknown*, not *did not happen*. Think of re-sending a read-only report request versus re-sending a payment: only the
author knows which one it is, and the label is the author's promise.

## A concrete scenario

An ops assistant can look up container movements and place holds on bookings. At 10:02 a user asks: *"place a hold on
`BK1001` for customs review and tell me the hold id"*.

| Moment | What happens |
| --- | --- |
| 10:02:01 | The model calls `request_booking_hold`. The hold is written to the outbox (the "booking system"). |
| 10:02:01 | The server is killed before the tool returns, so the user never gets a hold id. |
| 10:02:30 | The server restarts and resumes the unfinished run. |

What should Pi do with the unfinished call?

- **Run it again** → a second hold for the same request. Harmless for a lookup, wrong for a hold.
- **Leave it alone** → no duplicate, but nobody knows whether the hold exists, so the assistant must say so and let a human check.

Pi cannot tell which of the two is right, so the tool author declares it:

| In the scenario | In the lab |
| --- | --- |
| the lookup of container events | `get_container_events`, `replay: "safe"` |
| placing a hold | `request_booking_hold`, `replay: "unsafe"`, its effect is one line in the outbox |
| the booking system | `runtime-evidence/outbox-*.jsonl` |
| "how many times did the tool really run?" | the attempt log, `runtime-evidence/attempts-*.jsonl` |
| the author's promise | the `replay` field of the tool definition |

Who needs to understand this? **You, the developer**, when you write a tool. The end user only sees either a real answer or
"the outcome is unknown, please check".

## The idea

When a call starts, Pi commits its intent (a `pi.tool` task, including the tool's `replay` value) **before** `execute()` runs.
A killed process leaves that behind. On recovery:

```text
pi.tool task, intent committed, no result
  ├─ replay "safe"   → execute() runs again: same taskId, same callId → one real pi.tool-result
  └─ replay "unsafe" → execute() is not entered → an isError "interrupted" pi.tool-result
```

Three things to take away:

1. **A replay is the same call, not a new one.** The two executions share `taskId` and `callId`. If the model asks again
   after reading an `interrupted` result, that is a *retry* with a new call id, a different thing.
2. **Pi enforces the declaration; it cannot check that it is true.** An effectful tool wrongly declared `"safe"` is run
   again and duplicates its effect (an offline test does exactly this).
3. **`replay` is not idempotency.** Making a repeated effect harmless (an idempotency key, a conditional write) is the tool's own job.

Not covered: real notifications or APIs, provider/HTTP retry, exactly-once across systems Pi does not control. This lab
never shows exactly-once execution.

## The experiment

`npm run demo:replay` runs two scenarios against a live model. For each, a parent process starts a child CLI, waits for a named
`[Checkpoint]` line on its stdout (no sleeps), sends `SIGKILL`, then starts new children to recover:

| Scenario | Killed at | Why there |
| --- | --- | --- |
| `safe`: `get_container_events` | `tool_dispatched` | the call is durable, nothing is committed |
| `unsafe`: `request_booking_hold` | `effect_appended` | the outbox line already exists, the result is not committed |

Then it inspects the session, resumes it, and asks to resume a settled session again. The checkpoint lines carry `taskId` and
`callId`, so the killed call can be matched to the task `inspect()` reports, the attempt log, and the outbox record.

## What we measured

From one live run:

| tool | replay | executions of the killed call | replays | new calls by the model | outbox effects | committed results | committed result is |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `get_container_events` | safe | 2 | 1 | 0 | 0 | 1 | real result |
| `request_booking_hold` | unsafe | 1 | 0 | 0 | 1 | 1 | interrupted (`isError`) |

- **Safe:** the same `[Checkpoint] tool_dispatched … taskId=12 callId=…` line is printed twice, once per process, because
  `execute()` really ran twice. Still exactly one result is committed, and it is the real one.
- **Unsafe:** one execution and one outbox line with the same `taskId` and `callId`. The transcript says the call "was
  interrupted and may have partially run" while the outbox holds one effect; both are true.
- **`inspect()` before `resume()`** already shows `replay=safe` or `replay=unsafe` on the unfinished `pi.tool` task, plus its
  waiting `pi.generation`: the generation owns the tool task and cannot finish before it does.
- **Neither recovered trace has a `▶ tool_start`:** the event stream carries none for a call a previous process started. You tell
  the policies apart from the `tool_end` line (`↺ … recovery ran the call again` versus `↺ interrupted …`).
- **After an `interrupted` result** the model may ask for the hold again with a new call id. That is a retry; Pi does not stop
  it and neither does this lab. The `new calls by the model` column shows when it happens.

The offline tests (`tests/replay-recovery.test.ts`) reproduce the kill without killing anything: at each tool's checkpoint they
copy the session directory, attempt log, and outbox, then recover from the copy with a new `Harness`. They also cover the
wrongly declared case: the hold tool declared `"safe"` is rerun and its outbox gets **two** records for one call.

## Run it

```bash
cd lab-09-tool-replay-safety
npm install
cp .env.example .env     # then fill in DEEPSEEK_API_KEY
npm run check            # typecheck + 54 offline tests, no model calls
npm run demo:replay      # the live experiment above
```

Try it by hand:

```bash
npm run agent -- --session try --prompt "What are the movement events for container MSKU1234567?"
cat runtime-evidence/attempts.jsonl                  # one line: one real execution
grep -c 'pi.tool-result' session-data/try/main.jsonl # 1
npm run agent -- --session try --resume --settled    # re-reading a settled submission runs nothing
```

`SAFE_TOOL_DELAY_MS` and `HOLD_TOOL_DELAY_MS` (default 8000) set how long each tool waits after starting; the demo uses 15000.
Do not hand-edit `session-data/` or `runtime-evidence/` (git-ignored, regenerable).

## Test yourself

Before running the demo, write down your answers to 1–3; the rest after:

1. After a kill, what does a tool that declares `"safe"` do on recovery, and what does one that declares `"unsafe"` do?
2. Which two ids show that a replay is one logical call and not two?
3. Where would you look to count how many times a tool really ran, and why is Pi's own session not enough?
4. `interrupted` and one outbox record appear together. Are they in conflict? What does `interrupted` promise?
5. A hold tool is wrongly declared `"safe"`. Who made the mistake, and which layer should have prevented the duplicate?
6. The model asks for the hold again with a new call id. Is that a replay? Which layer must stop it?

(No learner prediction has been recorded for this lab.)

## Good to know

- **Pins:** `pi-durable`, `pi-ai`, `chord` `1.1.0` (`pi-durable` is experimental, so this was read from its types and `dist` and then observed). Default model `deepseek-flash`.
- An omitted `replay` means `"unsafe"`. The lab declares it explicitly on the hold tool so the contrast is visible.
- Recovery reruns a call only when the policy stored with the intent **and** the installed tool both say `"safe"`. That second
  condition was read from `dist/harness/tool.js`, and `tests/replay-recovery.test.ts` pins both directions (safe at crash and unsafe at recovery, and the reverse).
- `execute(args, api, context)` has no invocation id: a logical call is `api.taskId` plus `api.callId`. `api.memo` exists but is not used, since a memo would not make an external effect idempotent.
- `resume()` returns nothing, and resuming an already settled session returns its stored record instead of an error.
- Two processes on one session id are unsupported: `pi-durable` does not lock a storage across processes.
- Provider/connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md). If the demo hangs without a checkpoint, the model did not call the tool; rerun.

## Where things are

```text
src/get-container-events-safe-tool.ts   replay: "safe": read-only, slow, records every attempt
src/request-booking-hold-tool.ts        replay: "unsafe": appends to the outbox, then waits
src/attempt-log.ts, outbox-repository.ts   the count and the effect, kept outside Pi's own JSONL
src/checkpoint.ts                       marker the tools print and the demo waits for
src/create-harness.ts, session-store.ts, transcript.ts, cli.ts, harness-trace-logger.ts, booking-repository.ts, container-event-repository.ts
scripts/replay-safety-demo.ts           kill at each checkpoint, resume, re-read
tests/replay-recovery.test.ts           the offline proof (disk snapshot at the checkpoint)
```
