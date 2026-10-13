# Lab 06 — Failures and Concurrency

English | [中文](README.zh-CN.md)

**Question:** what does Pi do when a tool fails, a tool is slow, tools run in parallel, or another message arrives
while a run is still going?
**Answer this lab shows:** it behaves in three predictable ways, and one rule is yours to write:

- **A failure becomes a message, not a crash.** A tool that throws turns into one error tool result; the next turn
  reads it and answers.
- **Order is by request, not by finish time.** Parallel tools may finish in any order, but their results are always
  stored in the order the model asked for them.
- **A queued message waits for a specific moment.** `steer()` is delivered after the current tool batch;
  `followUp()` only after the agent would otherwise stop.
- **What to do with a second message is your policy.** Pi gives you the two queues; this lab chooses `followUp()` and
  never starts a second `prompt()`.

Think of a restaurant kitchen: a burnt dish is sent back as a note (not a fire), plates go out in the order
ordered even if the soup was ready first, and a new order shouted mid-service goes on the ticket rail, not into the
pan the cook is holding.

## A concrete scenario

You run a shipment-status assistant in a team chat. Dana asks: *"Investigate booking BK1001."* `BK1001` has two
containers, and the port-status lookup is slow today (say 900 ms):

1. The assistant looks up the booking, then asks for both containers' events and the port status in one go. The
   events return at once; the port status is still running.
2. While it waits, Dana adds *"also, will the delay get worse?"* Without a rule, that message could start a second
   run on the same conversation, interleaving two sets of tool results — or be dropped. With this lab's rule it joins
   a queue and is answered in order.
3. A colleague asks about `BAD_ID`. The lookup throws; the assistant says it found no such booking and invents no
   container.
4. Next week someone asks "why did the answer arrive so late?" You open the log and rebuild exactly what ran when,
   without reading the answer.

| In the scenario | In the lab |
| --- | --- |
| the slow port lookup | `get_port_status` with `LAB06_PORT_STATUS_DELAY_MS` |
| "also, will it get worse?" mid-run | `agent.steer()` (Experiment B) or `agent.followUp()` (C) |
| the rule for a second message | `createConcurrentMessagePolicy` — queue as `followUp()` while `isStreaming` |
| the unknown booking | `get_booking("BAD_ID")` throws (Experiment A) |
| rebuilding what ran when | the trace tree with elapsed time, `turn=`, and `call=` ids |

Who needs to understand this? **You, the developer.** The user sees a slow answer; you decide what a second message
means and read the trace when something looks wrong.

## The idea

| Situation | What Pi does | Observed as |
| --- | --- | --- |
| tool throws | commits one `toolResult` with `status=error`, then runs another turn | A |
| `steer()` mid-tool | queued; delivered after the batch's `turn_end`, as the next turn's `user` message | B |
| `followUp()` mid-tool | queued; delivered only when the agent would otherwise stop, costing one extra turn | C |
| several calls in one message | run together; `tool_end` follows finish order, `toolResult`s follow request order | D |

Three things to take away:

1. **Queueing is not interrupting.** Neither queue stops a running tool. `steer()` is read at the end of the turn;
   `followUp()` one step later.
2. **Two orders exist and only one is stored.** The trace shows both: `tool_end` lines (finish order) and
   `[Timeline] source= transcript=` (request order = stored order).
3. **Pi has no rule for a busy conversation.** `prompt()` while a run is active is yours to prevent. Here
   [`concurrent-message-policy.ts`](src/concurrent-message-policy.ts) checks `agent.state.isStreaming` and queues.

Not covered: durable recovery, distributed workers, retries and idempotency, and a `steer()`-based policy.

## The experiment

Each experiment is one conversation and one CLI run; B and C delay `get_port_status` by 900 ms and call the queue the
moment it starts. `BK1001` (two containers), `BK1002` (one), and the port statuses are fixtures under
[`data/`](data/).

```bash
npm run agent -- --experiment a   # BAD_ID: tool error
npm run agent -- --experiment b   # slow tool + steer()
npm run agent -- --experiment c   # slow tool + followUp()
npm run agent -- --experiment d   # parallel batch (BK1001: 2 containers + port)
```

Write down your answers to the first three test-yourself questions before running them.

## What we measured

From one live run per experiment (`deepseek-flash`; timings vary):

| experiment | turns | what the trace showed |
| --- | --- | --- |
| A | 2 | one `tool_end status=error`, one error `toolResult`; answer: booking not found, no container |
| B | 3 | `steer()` at `+4185 ms`; `get_port_status` ended `+5093 ms`; `turn_end` `+5094 ms`; steering `user` message opens turn 3 at `+5096 ms` |
| C | 4 | turn 3 ends with the ordinary answer; the follow-up `user` message opens turn 4 afterwards |
| D | 3 | three calls in turn 2: `source=0,1,2` = `transcript=0,1,2`; answer assesses each container |

- **B and C differ by exactly one turn.** The steering message rides on the turn that was coming anyway; the
  follow-up waits for the answer you would otherwise have received, then costs a turn.
- **Neither queue made the slow tool finish earlier.** `tool_end get_port_status` came after both
  `get_container_events` ends in every run.
- **D with a 900 ms delay:** the container calls ended at `+3979 ms`, the port call at `+4880 ms`, yet `transcript=`
  stayed `0,1,2`. In a live run the model requests `get_port_status` last, so finish order and request order agree.
  The case where they disagree (slow tool requested first) is proven offline in `tests/agent-loop.test.ts`.
- **One `toolResult` per `toolCallId`.** D's run has 4 requests, 4 `tool_start`, 4 `toolResult` lines.

The offline tests (44, no model calls) also cover: the real `Agent` with a scripted stream for A–D, the exact turn
at which `steer()` versus `followUp()` is read, a same-tick second `sendMessage` becoming a follow-up on a real
agent, and the trace's fixed-width columns.

## Run it

```bash
cd lab-06-failures-and-concurrency
npm install
cp .env.example .env     # then fill in DEEPSEEK_API_KEY
npm run check            # typecheck + 44 offline tests, no model calls
npm run agent -- --experiment d
```

Try it by hand:

```bash
LAB06_PORT_STATUS_DELAY_MS=900 npm run agent -- --experiment d | grep -E "tool_end|Timeline\]   id"
npm run agent -- --experiment a | grep -E "tool_end|\[Assistant\]"
npm run agent -- --experiment d | grep -c "assistant (tool call)"      # 4: one booking + three evidence calls
```

Reading the trace: every line is `[conversation] t=<elapsed> turn=N` (elapsed is monotonic and padded so the tree stays
aligned). `assistant (tool call) <name> call=<id> args=…` is the model's request; the `tool_start`/`tool_end` pair is
Pi executing it; `call=` pairs them. `[Harness]` lines are the experiment's own queue calls.

## Test yourself

Answer 1–3 before running the experiments, the rest after:

1. In B, does the steering message get answered before or after `get_port_status` ends, and in which turn?
2. Is B's turn count the same as C's? Why?
3. If one of D's calls ends first, does the stored result order change?
4. Which log line proves Pi, not the model, treated `BAD_ID` as an error?
5. What does `sendMessage` do that two `agent.prompt()` calls in a row do not?
6. Why can a live run not show finish order and request order disagreeing, and where is it shown instead?

(No learner prediction has been recorded for this lab.)

## Good to know

- **Pins:** `pi-agent-core` and `pi-ai` `1.1.0`. Default model `deepseek-flash`.
- The first `sendMessage` flips `isStreaming` synchronously, so a second call in the same tick is already queued
  (tested on a real `Agent`).
- A booking can have several containers (`containerNos`); delay is assessed per container.
- Provider/connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md).

## Where things are

```text
src/concurrent-message-policy.ts   second message while busy → followUp()
src/session-registry.ts            Map<conversationId, Agent> (from Lab 05)
src/trace-logger.ts                run/turn/tool tree with elapsed, turn, call ids
src/create-agent.ts, cli.ts        agent construction; --experiment a|b|c|d
src/get-*-tool.ts, *-repository.ts the three tools and fixtures (from Lab 04)
tests/agent-loop.test.ts           real Agent + scripted stream: A–D and the policy
```
