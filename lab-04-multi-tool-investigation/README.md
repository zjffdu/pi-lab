# Lab 04 — Multi-tool Shipment Investigation

Give Pi three tools instead of one, where two of them need arguments produced by the first, and watch how it chains and parallelizes them.

## Learning objective

By the end of this lab, you can explain this sequence from your own console output:

```text
get_booking(bookingNo)
  -> containerNo + origin
  -> get_container_events(containerNo)
  -> get_port_status(origin)
  -> evidence-based synthesis
```

`get_container_events` and `get_port_status` are independent of each other once `get_booking` resolves — Pi's default parallel tool execution may request both in the same assistant turn. Exact turn count is not an acceptance criterion; what matters is the dependency and the evidence in the final answer.

This lab builds directly on [Lab 01](../lab-01-pi-agent-loop/README.md)'s agent loop. It does not add Teams, multi-turn conversation state, or durable workflow execution — see [Lab 03](../lab-03-teams-pi/README.md) and [Lab 05](../ROADMAP.md) for those.

## Domain rule

- A `LOAD` event later than the booking's `plannedDeparture` is evidence of a departure delay.
- High port congestion is an additional risk signal, observed at its own `observedAt` timestamp.
- Congestion must never be claimed as the proven cause of a delay — it is correlational only.
- All fixture timestamps carry an explicit UTC (`Z`) suffix.

## Prerequisites

- Node.js 24.5 or newer
- npm
- Credentials for a model provider supported by `@earendil-works/pi-ai`

The default configuration uses DeepSeek Flash through the official DeepSeek API, same as Lab 01.

## 1. Predict before running

Write down your answers before starting the agent:

1. Which tool must run first, and why can the model not call `get_container_events` or `get_port_status` before it?
2. Once `get_booking` returns, which two tools can run in the same assistant turn?
3. If the port-status fixture is missing an entry, what should the final answer say instead of guessing?
4. Does a high congestion reading prove that congestion caused an observed delay?

Do not inspect the expected trace yet.

## 2. Install dependencies

```bash
cd lab-04-multi-tool-investigation
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

The Pi dependencies are pinned to `1.1.0` so later SDK changes do not silently alter this lab.

Pi `1.1.0` catalogs the model as `deepseek-flash`. Leave `PI_MODEL` unset or set it to `deepseek-flash` in `.env`; `npm run check` fails if the default model id stops resolving in the pinned catalog.

## 3. Verify the deterministic parts

```bash
npm run check
```

This covers all three repositories, all three tools' success and not-found paths, the timeline trace logger, and the default model resolving in the pinned Pi catalog. It also drives the real Pi `Agent` with a scripted stream function (`tests/agent-loop.test.ts`), so the dependent `get_booking` -> parallel evidence chain is checked against Pi `1.1.0` itself: `tool_execution_end` arrives in completion order, tool results stay in assistant source order, a failing tool in a parallel batch does not drop its sibling's result, and the transcript starts with the `system` message. Everything runs against local fixtures; no network calls.

## 4. Run the agent

```bash
npm run agent
```

Or ask your own question:

```bash
npm run agent -- "Investigate booking BK1002 for departure delay and port risk"
```

## 5. Happy path

Ask about `BK1001` (the default question). `src/investigation-trace-logger.ts` renders the
same indented agent/turn/tool tree as Lab 01's logger — a tool call is never its own
push/pop span, precisely so two genuinely overlapping calls (like turn #2 below) render as
flat siblings instead of one falsely nested inside the other; the `[Timeline]` block is what
actually reconstructs their real start/end relationship. Actual terminal trace from one
recorded live run (call ids and the final answer elided; exact wording and turn count vary by model):

```text
▶ agent
  ▶ turn #1
    user       "Investigate booking BK1001: is there evidence of a departure delay, and what is the port congestion risk?"
    [Assistant] I'll start by resolving the booking to get the container number and origin port.
    assistant (tool call) get_booking call=call_00_9kKvn... args={"bookingNo":"BK1001"}
    ▶ tool_start get_booking call=call_00_9kKvn... args={"bookingNo":"BK1001"}
    ◀ tool_end get_booking status=success
    toolResult get_booking status=success
    [Timeline] tool_calls=1
    [Timeline]   get_booking source=0 transcript=0 start=+3961ms end=+3964ms duration=3ms
  ◀ turn_end #1 tool_results=1
  ▶ turn #2
    [Assistant] Now I'll request the container events and port status in the same batch.
    assistant (tool call) get_container_events call=call_00_TUGlM... args={"containerNo":"MSKU1234567"}
    assistant (tool call) get_port_status call=call_01_4dM7T... args={"portCode":"CNSHA"}
    ▶ tool_start get_container_events call=call_00_TUGlM... args={"containerNo":"MSKU1234567"}
    ▶ tool_start get_port_status call=call_01_4dM7T... args={"portCode":"CNSHA"}
    ◀ tool_end get_container_events status=success
    ◀ tool_end get_port_status status=success
    toolResult get_container_events status=success
    toolResult get_port_status status=success
    [Timeline] tool_calls=2
    [Timeline]   get_container_events source=0 transcript=0 start=+6245ms end=+6258ms duration=13ms
    [Timeline]   get_port_status source=1 transcript=1 start=+6249ms end=+6258ms duration=9ms
  ◀ turn_end #2 tool_results=2
  ▶ turn #3
    [Assistant] ...fixture-backed delay/risk analysis...
  ◀ turn_end #3 tool_results=0
◀ agent_end
```

An `assistant (tool call) <name> call=<id> args=<json>` line is the model's *request*, with the arguments it chose; the `tool_start`/`tool_end` pair is Pi actually executing that call, and the `call=` id pairs the two. When the model requests several tools in one message (turn #2), each request gets its own line, and Pi starts them together.

Notice that `get_port_status` can finish before `get_container_events` (its `end=` timestamp is earlier), yet both `transcript=` positions still follow the order the model requested them in (`source=`). Pi reassembles tool-result messages in assistant source order regardless of which tool physically finished first — only the timeline's start/end timestamps reveal real completion order.

The final answer should read roughly as: `MSKU1234567` loaded after its planned departure (delay evidence), `CNSHA` was observed at high congestion around the same time (risk signal), and congestion is not claimed as the proven cause.

## 6. Inject a failure — missing port-status evidence

Open `data/port-status.json` and temporarily remove the `CNSHA` entry (or rename its `portCode`). Re-run:

```bash
npm run agent
```

Observe `◀ tool_end get_port_status status=error` and confirm the final answer states plainly that port status could not be found, instead of inventing a congestion level. Restore `data/port-status.json` afterward.

## 7. Inject a failure — slow independent tool

Set an artificial delay on `get_port_status` and re-run:

```bash
LAB04_PORT_STATUS_DELAY_MS=800 npm run agent
```

Compare the `[Timeline]` block's `start=`/`end=`/`duration=` values against the earlier happy-path run. `get_container_events` should now finish well before `get_port_status`, while `transcript=` order for both tools is unchanged — direct evidence that completion order and transcript order are independent under parallel execution.

## 8. Explain the trace

Answer using your terminal output:

1. Which log line proves `get_booking` had to complete before the second turn's tool batch could start?
2. In the delayed run, did `source=` or `transcript=` order change for either tool? Why or why not?
3. What in the final answer distinguishes "observed delay evidence" from "risk signal" from "what the evidence does not establish"?

## Completion criteria

- `npm run check` passes (repository and tool success/not-found tests, plus the timeline logger tests).
- A live run for `BK1001` obtains `containerNo` and `origin` from `get_booking` before calling the other two tools, and calls no invented identifiers.
- The final answer separates observed delay, risk signal, and unknown causality, per the domain rule.
- Removing the `CNSHA` port-status fixture entry produces a final answer that states the missing evidence instead of fabricating a congestion level.
- The `[Timeline]` block shows `get_container_events` and `get_port_status` sharing the same turn, with `transcript=` order matching `source=` order even when their `end=` timestamps differ (see step 7).
- You can explain why exact turn count is not part of these criteria.

## The transcript versus the trace

- **The transcript starts with the system prompt.** `agent.state.messages` is `system`, `user`, `assistant`, `toolResult`, `assistant`, `toolResult`, `toolResult`, `assistant`. The system message carries the prompt and the tool declarations, and it is what the model receives on every call, together with the full history so far. It emits no `message_*` event, so it never appears in the trace tree.
- **The trace shows events, not the whole transcript.** Each `message_end` and each `tool_execution_*` event is printed once, when it happens. Turn #2 prints no `user` line because no new user message was added; its input is the transcript built during turn #1.
- **Completion order and result order are different things.** `tool_execution_end` is emitted in the order tools finish, while the `toolResult` messages are appended in the order the model requested the calls. `tests/agent-loop.test.ts` checks this offline with `get_port_status` requested first and delayed, so source order and completion order disagree.
- **A failing tool does not drop its siblings.** When one call in a parallel batch ends with `status=error`, the other call's result is still appended and the next turn starts.
- **Provider failures end the run with an `error` message.** The run ends with an `assistant` message whose `stopReason` is `error`, and `agent.state.errorMessage` is set, which is what makes the CLI exit non-zero.

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider connection issues — they apply unchanged here, including the `--use-env-proxy` requirement baked into `npm run agent`. In particular, `Unknown model deepseek/<id>` means `.env` sets a model id that is not in the pinned Pi `1.1.0` catalog; keep `PI_PROVIDER=deepseek` and `PI_MODEL=deepseek-flash`.
