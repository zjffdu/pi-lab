# Lab 04 — Multi-tool Shipment Investigation

English | [中文](README.zh-CN.md)

**Question:** when one tool's output is the input of the next tools, who decides the order and what runs together?
**Answer this lab shows:** the model decides, and Pi runs whatever it asks for:

- **The dependency lives in text, not in code.** Nothing in Pi knows that `get_container_events` needs `get_booking`
  first. The model learns it from the system prompt and the tool descriptions, and it cannot fill a required
  argument it has not seen yet, so `get_booking` comes first.
- **Independent calls run together.** Once `get_booking` has answered, the model can request every remaining call in
  one message, and Pi's default parallel execution starts them all at once. Results still enter the transcript in
  the order they were requested, not the order they finished.

Think of a dispatcher who must read the booking sheet before phoning anyone, then phones the container yard and
the port office at the same time and files the notes in the order the calls were made.

## A concrete scenario

A customer-service agent asks the assistant: *"Is booking `BK1001` late, and is the port a problem?"* `BK1001` has
two containers, `MSKU1234567` and `MSKU2345678`, loading at `CNSHA`, planned to depart `2026-09-10T08:00:00Z`.

- **Without this lab's approach**, you write the sequence by hand: look up the booking, loop over containers, call the
  port service, merge. Every new data source is more glue code, and the order is frozen.
- **With it**, you give the model three small tools and the rules of the business:
  - Turn 1: the model can only call `get_booking`, because the container numbers and the port code exist nowhere else.
  - Turn 2: it requests the events of both containers and the port status in one message. Pi starts all three together.
  - Turn 3: it answers per container. Both loaded later than planned departure (delay evidence), `CNSHA` reports
    high congestion (a risk signal), and the answer says congestion is not shown to be the cause.
- If the port service has no record for `CNSHA`, the answer still gives both containers' delay evidence and says
  plainly that no congestion reading exists, instead of guessing one.

Who has to understand this? **You, the developer.** The agent only sees the answer. The lab teaches you where the
ordering rule lives (descriptions and prompt), what Pi guarantees about parallel calls, and how to read the timeline.

| In the scenario | In the lab |
| --- | --- |
| the booking sheet | `get_booking` → `containerNos[]` and `origin` |
| phone the yard once per container | `get_container_events`, one call per container |
| phone the port office | `get_port_status` |
| "late" for one container | a `LOAD` event after `plannedDeparture` |
| "the port might be a problem" | high congestion: a risk signal, never a proven cause |

## The idea

```text
get_booking(bookingNo)
  -> containerNos[] + origin
  -> get_container_events(containerNo)   once per container, together with ...
  -> get_port_status(origin)             ... this call, in the same turn
  -> per-container delay evidence + risk signal + what is not established
```

Three things to take away:

1. **Order comes from data the model has and does not have.** A required argument it has not seen forces a turn
   boundary; the descriptions and prompt say which calls are independent. Pi itself enforces no order.
2. **Two orders exist and they differ.** `tool_execution_end` events arrive in completion order. The `toolResult`
   messages in the transcript are appended in the order the model requested the calls. The trace's `[Timeline]` block
   prints `source=` (requested), `transcript=` (appended), and real start/end times so you can see both.
3. **A failing call does not take its siblings down.** A call that ends with `status=error` becomes an error result;
   the other results are kept and the next turn starts.

Not covered: Teams, multi-turn conversation state, durable workflows, real shipment systems (the fixtures are local).

## The experiment

Fixtures are under [`data/`](data/): `bookings.json` (`BK1001` has two containers, `BK1002` has one),
`container-events.json`, and `port-status.json`; every timestamp ends in `Z`. `npm run agent` runs one prompt through the
live model. Four runs, all with `deepseek-flash`:

1. `BK1001` as is.
2. `BK1001` with the `CNSHA` entry temporarily removed from `data/port-status.json` (restored afterwards).
3. `BK1001` with `LAB04_PORT_STATUS_DELAY_MS=800`, which delays only `get_port_status`.
4. `BK1002` (one container) and `BAD_ID` (unknown booking).

## What we measured

From one live run each (turn #2's calls; durations from the `[Timeline]` block):

| run | calls in turn #2 | `get_port_status` | each `get_container_events` | final answer |
| --- | --- | --- | --- | --- |
| `BK1001` | 3 together | success, 6 ms | success, 6 ms | both containers delayed; congestion high, not claimed as cause |
| port status removed | 3 together | `status=error`, 7 ms | success, 6–7 ms | both containers delayed; "no port status found", no congestion reading |
| 800 ms delay | 3 together | success, 811 ms | success, 9–10 ms | same as the first row |
| `BK1002` | 2 together (one container) | success | success | no delay: `LOAD` before planned departure |
| `BAD_ID` | none; the run ends after turn #2 | – | – | "Booking not found", nothing invented |

- **Turn #1 is always `get_booking` alone**, in every run. The later calls appear only after its result is in the transcript.
- **The number of container calls follows `containerNos`**: two for `BK1001`, one for `BK1002`.
- **In the delayed run the three calls still start within 1 ms of each other**, and the answer waits for the slowest.
- **Live, the delayed tool was also the last one requested**, so completion order and request order agreed. Making
  them disagree needs the model to request the port first, which it did not; the offline test below forces it.

The offline tests drive the real Pi `Agent` with a scripted stream (no network). They request `get_port_status`
first, delay it, and check that `tool_execution_end` arrives in completion order while the `toolResult` messages stay
in request order, that a failing tool keeps its siblings' results, and that the transcript starts with a `system`
message and is resent in full on every call.

## Run it

```bash
cd lab-04-multi-tool-investigation
npm install
cp .env.example .env     # then fill in DEEPSEEK_API_KEY
npm run check            # typecheck + 31 offline tests, no model calls
npm run agent            # the default BK1001 question, live
```

Try it by hand:

```bash
npm run agent -- "Investigate booking BK1002 for departure delay and port risk"
LAB04_PORT_STATUS_DELAY_MS=800 npm run agent
npm run agent -- "Investigate booking BAD_ID"
```

Reading the trace: an `assistant (tool call) <name> call=<id> args=<json>` line is the model's request; the
`tool_start`/`tool_end` pair is Pi executing it, and `call=` pairs them. Turn #2 prints no `user` line because no new
user message was added. `[Timeline]` lines show `source=` / `transcript=` / `start=` / `end=` / `duration=`, with times
relative to `agent_start`.

## Test yourself

Before running anything, write down your answers to 1–3; the rest after:

1. Which tool can the model call first, and why can it not call the other two before it?
2. `BK1001` has two containers. How many calls can run in the same turn after `get_booking`, and which?
3. If `get_port_status` fails, what should the answer say about congestion?
4. In the delayed run, did `source=` or `transcript=` change for any call? Why, or why not?
5. Which log line shows that the model requested a call, and which shows that Pi ran it?
6. Why does the answer say "congestion is not shown to be the cause" even when the reading is high?

(No learner prediction has been recorded for this lab.)

## Good to know

- **Pins:** `pi-agent-core` and `pi-ai` `1.1.0`. Default model `deepseek-flash`; `npm run check` fails if it stops
  resolving in the pinned catalog.
- The agent uses `toolExecution: "parallel"` on purpose; the order rule is in the prompt and descriptions, which is
  also why a different model may batch differently. Exact turn count is not part of the lab's pass criteria.
- `LAB04_PORT_STATUS_DELAY_MS` exists only for this experiment; unset or `0` means no delay.
- Provider/connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md). `Unknown model deepseek/<id>` means
  `.env` names a model that is not in the pinned catalog; keep `PI_MODEL=deepseek-flash`.

## Where things are

```text
src/booking-repository.ts, container-event-repository.ts, port-status-repository.ts   validated fixture access
src/get-booking-tool.ts, get-container-events-tool.ts, get-port-status-tool.ts       the three tools
src/create-agent.ts                  model, system prompt (the ordering and evidence rules), parallel Agent
src/investigation-trace-logger.ts    agent/turn/tool tree plus the [Timeline] block
src/cli.ts                           entrypoint; a failed run exits non-zero
tests/agent-loop.test.ts             real Agent, scripted stream: order, siblings, transcript
```
