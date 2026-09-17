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

The default configuration uses DeepSeek V4 Flash through the official DeepSeek API, same as Lab 01 and Lab 03.

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

## 3. Verify the deterministic parts

```bash
npm run check
```

This covers all three repositories, all three tools' success and not-found paths, and the timeline trace logger — entirely against local fixtures, no network calls.

## 4. Run the agent

```bash
npm run agent
```

Or ask your own question:

```bash
npm run agent -- "Investigate booking BK1002 for departure delay and port risk"
```

## 5. Happy path

Ask about `BK1001` (the default question). Expected terminal trace (illustrative — exact wording and turn count vary by model):

```text
[Pi] agent_start
[Pi] turn_start #1
[Tool] start get_booking args={"bookingNo":"BK1001"}
[Tool] end get_booking status=success
[Pi] turn_end #1 tool_results=1
[Pi] turn_start #2
[Tool] start get_container_events args={"containerNo":"MSKU1234567"}
[Tool] start get_port_status args={"portCode":"CNSHA"}
[Tool] end get_port_status status=success
[Tool] end get_container_events status=success
[Timeline] turn #2 tool_calls=2
[Timeline]   get_container_events source=0 transcript=0 start=+143ms end=+512ms duration=369ms
[Timeline]   get_port_status source=1 transcript=1 start=+148ms end=+301ms duration=153ms
[Pi] turn_end #2 tool_results=2
[Pi] turn_start #3
[Assistant] ...
[Pi] turn_end #3 tool_results=0
[Pi] agent_end
```

Notice that `get_port_status` can finish before `get_container_events` (its `end=` timestamp is earlier), yet both `transcript=` positions still follow the order the model requested them in (`source=`). Pi reassembles tool-result messages in assistant source order regardless of which tool physically finished first — only the timeline's start/end timestamps reveal real completion order.

The final answer should read roughly as: `MSKU1234567` loaded after its planned departure (delay evidence), `CNSHA` was observed at high congestion around the same time (risk signal), and congestion is not claimed as the proven cause.

## 6. Inject a failure — missing port-status evidence

Open `data/port-status.json` and temporarily remove the `CNSHA` entry (or rename its `portCode`). Re-run:

```bash
npm run agent
```

Observe `[Tool] end get_port_status status=error` and confirm the final answer states plainly that port status could not be found, instead of inventing a congestion level. Restore `data/port-status.json` afterward.

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

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider connection issues — they apply unchanged here, including the `--use-env-proxy` requirement baked into `npm run agent`.
