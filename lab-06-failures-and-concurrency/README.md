# Lab 06 — Failures and Concurrency

Give the Lab 04 tools and the Lab 05 session registry a harder job: a tool that fails, a tool
that runs slowly while a second message shows up, and two independent tools racing inside one
turn. This lab does not add new capabilities — it adds pressure to the ones already built and
watches what Pi actually does under it.

## Learning objective

By the end of this lab, you can explain, from your own console output, all of the following:

1. A tool error becomes one bounded tool-result message, never a fabricated answer.
2. `steer()` is injected only after the current turn's tool calls all finish — not the instant
   you call it, even if a tool is still running.
3. `followUp()` waits longer than `steer()`: it is only checked once the agent would otherwise
   have stopped (no more tool calls, no pending steering), which can mean an entire extra turn
   after the "final" answer you would have seen without it.
4. Two independent tools requested in the same assistant turn can finish in either order, but
   Pi always reassembles their tool-result messages in the order the assistant requested them
   (source order), never completion order.
5. A second message to a conversation whose agent is still running is never a second concurrent
   `prompt()` call, a silent drop, or a rejection — this lab's registry always queues it with
   `followUp()` instead.

This lab builds on [Lab 04](../lab-04-multi-tool-investigation/README.md)'s three tools and
[Lab 05](../lab-05-multi-turn-sessions/README.md)'s `Map<conversationId, Agent>` registry — see
the [roadmap](../ROADMAP.md) for how those two labs fit together. It does not add durable
recovery, distributed workers, or database-backed state — see the roadmap's "After Lab 06"
section for those.

## Domain rule (unchanged from Lab 04)

- A `LOAD` event later than the booking's `plannedDeparture` is evidence of a departure delay.
- High port congestion is an additional risk signal, observed at its own `observedAt` timestamp.
- Congestion must never be claimed as the proven cause of a delay — it is correlational only.

## This lab's concurrency policy

Lab 05 explicitly deferred "what happens if a second message arrives while the first is still
running" to this lab. The answer lives in
[`src/concurrent-message-policy.ts`](src/concurrent-message-policy.ts):

> If `agent.state.isStreaming` is `true` when a message arrives for that conversation, the
> message is queued with `agent.followUp()`. It is never started as a second `prompt()` call,
> never dropped, and never rejected. The caller gets back a promise that resolves once the
> original run — including any follow-ups queued into it — fully settles.

This is deterministic and covered by
[`tests/concurrent-message-policy.test.ts`](tests/concurrent-message-policy.test.ts) using a
fake agent whose `prompt()` does not resolve until the test tells it to, so a second call can
land while the first is still "streaming."

## Prerequisites

- Node.js 24.5 or newer
- npm
- Credentials for a model provider supported by `@earendil-works/pi-ai`

The default configuration uses DeepSeek V4 Flash through the official DeepSeek API, same as
Labs 01, 03, 04, and 05.

## 1. Predict before running

Write down your answers before starting the agent:

1. Experiment A: when `get_booking("BAD_ID")` throws, what turns does the trace show, and what
   should the final answer say instead of guessing a container number?
2. Experiment B: if you call `agent.steer(...)` the instant `get_port_status` starts, and that
   tool takes 900ms to return, does the steering message get answered before or after
   `get_port_status` finishes? Does it appear in the same turn as the original answer, or a new
   one?
3. Experiment C: same setup, but with `agent.followUp(...)` instead of `agent.steer(...)`. Is
   the number of turns before `agent_end` the same as Experiment B, or different? Why?
4. Experiment D: `get_container_events` and `get_port_status` are requested in the same
   assistant turn. If one tool call finishes before the other, does the transcript's tool-result
   order change to match?
5. If a second `sendMessage` call arrives for a conversation whose agent is already running, does
   this lab's registry start a second `prompt()`, drop the message, or something else?

Do not inspect the expected trace below yet.

## 2. Install dependencies

```bash
cd lab-06-failures-and-concurrency
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

## 3. Verify the deterministic parts

```bash
npm run check
```

This covers all three repositories, all three tools' success and not-found paths, the session
registry (reuse, isolation, reset), the concurrency policy (prompted vs. queued-as-follow-up),
and the trace logger (monotonic timing, turn numbers, `toolCallId`, conversation id) — entirely
against local fixtures and fakes, no network calls.

## 4. Run the experiments

Each experiment is its own conversation and its own CLI invocation:

```bash
npm run agent -- --experiment a   # Tool error
npm run agent -- --experiment b   # Slow tool + steer()
npm run agent -- --experiment c   # Slow tool + followUp()
npm run agent -- --experiment d   # Parallel tools
```

### Experiment A — Tool error

Calls `get_booking("BAD_ID")`. Expect one `[Tool] ... status=error` line and a final answer that
says the booking was not found — never an invented container number.

### Experiment B — Slow tool and steering

Sets `get_port_status`'s artificial delay to 900ms (override with
`LAB06_PORT_STATUS_DELAY_MS`) and calls `agent.steer(...)` the moment `get_port_status` starts.
Watch for the injected `message_start role=user` line: it appears only after **both**
`get_container_events` and `get_port_status` have ended, in the very next turn — not the instant
`steer()` was called.

### Experiment C — Follow-up queue

Same setup, but with `agent.followUp(...)` instead. Compare the total turn count against
Experiment B: the follow-up is not injected into the turn that would have been the agent's
final answer — it waits for that turn to fully finish and produces one additional turn on top of
it.

### Experiment D — Parallel tools

The Lab 04 happy path, replayed through this lab's richer trace logger. Watch the `[Timeline]`
block: `source=` and `transcript=` stay aligned for both tools even when their `end=` timestamps
differ.

## 5. Evidence collected in this session

Real (non-illustrative) excerpts from live runs, trimmed to the lines that matter. Exact wording,
timing, and turn count will vary by model and machine — the *shape* is what to check for.

**Experiment A** — the model never claims a container number for `BAD_ID`:

```text
[Tool][experiment-a] t=+817.78ms turn=1 id=call_00_... start get_booking args={"bookingNo":"BAD_ID"}
[Tool][experiment-a] t=+824.47ms turn=1 id=call_00_... end get_booking status=error
[Assistant][experiment-a] Booking BAD_ID was not found, so there is no container number to report...
```

**Experiment B** — `steer()` was called at `t=+1582ms`, while `get_port_status` was still running
(it did not end until `t=+2491ms`); the steering message is not injected until *after* that,
as `turn=3`, immediately following `turn=2`'s `turn_end`:

```text
[Tool][experiment-b] t=+1582.35ms turn=2 id=call_01_... start get_port_status args={"portCode":"CNSHA"}
[Harness][experiment-b] steer() while get_port_status is still running
[Tool][experiment-b] t=+2491.62ms turn=2 id=call_01_... end get_port_status status=success
[Pi][experiment-b] t=+2491.75ms turn=2 turn_end tool_results=2
[Pi][experiment-b] t=+2491.76ms turn=3 turn_start
[Pi][experiment-b] t=+2491.77ms turn=3 message_start role=user
```

Only **one** more turn (`turn=3`) ran after the tool batch, and the assistant folded the steering
request straight into that same answer.

**Experiment C** — `followUp()` was called at the identical point in the run, but the shape is
different: `turn=3` still produced the agent's ordinary three-part answer (what would have been
the *final* answer without a queued follow-up), and only then did the follow-up appear, as a
**separate fourth turn**:

```text
[Pi][experiment-c] t=+4324.58ms turn=3 turn_end tool_results=0
[Pi][experiment-c] t=+4324.64ms turn=4 turn_start
[Pi][experiment-c] t=+4324.65ms turn=4 message_start role=user
[Assistant][experiment-c] Container MSKU1234567 (BK1001, CNSHA→NLRTM) loaded and departed...
[Pi][experiment-c] t=+5259.43ms turn=4 agent_end
```

This is the concrete difference between the two primitives: steering rides along with the turn
that was already going to run next; a follow-up only runs once the agent would otherwise have
stopped, which can mean paying for an entire extra turn.

**Experiment D** — both tools share `turn=2`; `get_port_status` and `get_container_events`
finish within microseconds of each other here (no artificial delay), and `transcript=` order
matches `source=` order for both:

```text
[Timeline][experiment-d]   id=call_00_... get_container_events source=0 transcript=0 start=+1739.14ms end=+1756.39ms duration=17.26ms
[Timeline][experiment-d]   id=call_01_... get_port_status source=1 transcript=1 start=+1739.86ms end=+1756.46ms duration=16.60ms
```

Re-run with `LAB06_PORT_STATUS_DELAY_MS=900 npm run agent -- --experiment d` to widen the gap
between the two `end=` timestamps and confirm `transcript=`/`source=` order still does not move.

## 6. Explain the trace

Answer using your own terminal output:

1. Which single log line proves Pi, not the model, decided `get_booking("BAD_ID")` was an error?
2. In Experiment B, how many turns ran after the tool batch, and in Experiment C? What does that
   difference tell you about when each queue is drained?
3. In Experiment D, did `source=` or `transcript=` order ever change for either tool, even when
   `end=` timestamps differed? Why not?
4. Look at the `[Pi] ... message_start role=toolResult` / `message_end role=toolResult` pairs for
   any turn with two tool calls. Is there ever more than one pair per tool call?
5. What does `sendMessage` in `concurrent-message-policy.ts` do differently from calling
   `agent.prompt()` twice in a row?

## Completion criteria

- `npm run check` passes (repository/tool tests, session registry tests, the concurrency policy
  test, and the trace logger tests).
- Experiment A's final answer states the booking was not found and invents no container number.
- The chosen same-conversation concurrency policy (queue as `followUp()` while `isStreaming`) is
  deterministic and covered by `tests/concurrent-message-policy.test.ts`.
- Experiment B's steering message is injected only after the current turn's tool calls finish;
  Experiment C's follow-up is injected only after the agent would otherwise have stopped, and the
  two produce a different turn count.
- Experiment D's `[Timeline]` block shows `transcript=` order matching `source=` order for both
  tools even when their `end=` timestamps differ.
- Every recorded tool call has exactly one `toolResult` message — no duplicates, no reordering.
- You can reconstruct each experiment's full timeline (turn numbers, `toolCallId`s, elapsed time)
  from the logs alone, without relying on the final answer text.

## Project map

```text
src/booking-repository.ts          Lab 04's fixture repository (own copy)
src/container-event-repository.ts  Lab 04's fixture repository (own copy)
src/port-status-repository.ts      Lab 04's fixture repository (own copy)
src/get-booking-tool.ts            Lab 04's tool (own copy) — Experiment A's failure path
src/get-container-events-tool.ts   Lab 04's tool (own copy)
src/get-port-status-tool.ts        Lab 04's tool (own copy) — artificial delay knob for B/C
src/session-registry.ts            Lab 05's Map<conversationId, Agent> registry (own copy)
src/concurrent-message-policy.ts   This lab's second-message-while-busy policy
src/trace-logger.ts                Monotonic time + turn + toolCallId + conversation id
src/create-agent.ts                Model, tools, and Agent construction
src/cli.ts                         Experiment harness (--experiment a|b|c|d)
data/                               Same fixtures as Lab 04
tests/                              Tests that do not call an LLM
```

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider connection issues — they
apply unchanged here, including the `--use-env-proxy` requirement baked into `npm run agent`.
