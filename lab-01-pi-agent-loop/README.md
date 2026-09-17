# Lab 01 — Observe the Pi Agent Loop

Build the smallest useful Pi agent and trace how one tool result causes the next LLM turn.

## Learning objective

By the end of this lab, you can explain this sequence from your own console output:

```text
user prompt
  -> first LLM turn
  -> get_booking tool call
  -> tool result enters the transcript
  -> second LLM turn
  -> final answer
```

This lab intentionally contains one tool and one local fixture. It does not include Teams, multiple tools, session persistence, or `AgentHarness`.

## Prerequisites

- Node.js 24.5 or newer
- npm
- Credentials for a model provider supported by `@earendil-works/pi-ai`

The default configuration uses DeepSeek V4 Flash through the official DeepSeek API. All booking data stays in the local fixture; the user prompt and tool transcript are sent to DeepSeek.

The CLI starts Node with `--use-env-proxy`. This lets the DeepSeek client honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` in networks that require an outbound proxy.

## 1. Predict before running

Write down your answers before starting the agent:

1. How many LLM turns do you expect?
2. Which event should occur immediately before `tool_execution_start`?
3. Where does the tool result go before the second LLM turn?
4. What should happen when the booking number does not exist?

Do not inspect the expected trace yet.

## 2. Install dependencies

```bash
cd lab-01-pi-agent-loop
npm install
```

The Pi dependencies are pinned to `0.85.1` so later SDK changes do not silently alter this lab.

## 3. Configure a model

```bash
cp .env.example .env
```

Set your DeepSeek API key:

```dotenv
PI_PROVIDER=deepseek
PI_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=...
```

Pi `0.85.1` catalogs the model as `deepseek-v4-flash`. As of September 17, 2026, DeepSeek temporarily routes this retired compatibility name to the latest `deepseek-flash` model, currently V4.1 Flash.

Never commit `.env`.

## 4. Verify the deterministic parts

```bash
npm run check
```

These tests verify fixture lookup, structured tool output, and the unknown-booking error. They do not call an LLM.

## 5. Run the happy path

```bash
npm run agent -- "What are the details for booking BK1001?"
```

The exact wording may vary. The lifecycle should have this shape:

```text
[Pi] agent_start
[Pi] turn_start #1
[Pi] message_start role=user
[Pi] message_end role=user
[Pi] message_start role=assistant
[Pi] message_end role=assistant
[Tool] start get_booking args={"bookingNo":"BK1001"}
[Tool] end get_booking status=success
[Pi] message_start role=toolResult
[Pi] message_end role=toolResult
[Pi] turn_end #1 tool_results=1
[Pi] turn_start #2
...
[Assistant] ...fixture-backed answer...
[Pi] turn_end #2 tool_results=0
[Pi] agent_end
```

The important invariant is not the wording. It is that the tool result appears before the second turn and the final answer uses fixture evidence.

## 6. Inject a failure

```bash
npm run agent -- "What are the details for booking BAD_ID?"
```

Observe:

- `get_booking` starts and ends with `status=error`.
- Pi gives the tool error back to the model.
- The next turn reports that the booking was not found.
- The answer does not invent booking details.

## 7. Explain the trace

Answer these questions using your console output:

1. Why is the first assistant message not necessarily the final answer?
2. Which event proves that Pi executed the tool rather than the model inventing data?
3. Which message carries the tool result into the second turn?
4. Why does `agent_end` occur only after the final assistant response?

## Completion criteria

- `npm run check` passes.
- `BK1001` produces a successful `get_booking` execution.
- `BAD_ID` produces a tool error and no fabricated booking.
- You can explain every turn in one captured trace.

## Project map

```text
src/booking-repository.ts  local fixture lookup
src/get-booking-tool.ts    Pi AgentTool adapter
src/create-agent.ts        model, prompt, and Agent construction
src/trace-logger.ts        lifecycle observation
src/cli.ts                 terminal entrypoint
data/bookings.json         deterministic evidence
tests/                     tests that do not call an LLM
```

## Troubleshooting

### `Unknown model provider/model`

Keep `PI_PROVIDER=deepseek` and `PI_MODEL=deepseek-v4-flash` when using the pinned Pi `0.85.1` dependencies.

### `Provider is not configured: deepseek`

Set `DEEPSEEK_API_KEY` in `.env`.

### Authentication error

Confirm that the provider-specific API key exists in `.env`. Do not print the key while debugging.

Pi records provider failures in `agent.state.errorMessage`. The CLI converts that state into a non-zero exit code instead of treating an empty response as success.

### `Connection error`

Confirm that your configured proxy is running and that `api.deepseek.com` is not included in `NO_PROXY`. `npm run agent` enables Node's environment-proxy support automatically.
