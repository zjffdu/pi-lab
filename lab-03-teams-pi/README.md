# Lab 03 — Teams to Pi

Combine the proven Lab 01 Agent Loop with the proven Lab 02 Teams transport: a thin adapter that hands one Teams message to a fresh Pi agent and returns Pi's final answer.

## Learning objective

By the end of this lab, you can trace one request across both layers using a single request ID:

```text
Teams message
  -> thin adapter (create-app.ts / message-handler.ts)
  -> new Pi Agent for this request (agent-runner.ts)
  -> DeepSeek
  -> get_booking
  -> final answer
  -> Teams reply
```

Non-goals for this lab:

- More than one tool (still just `get_booking`, from [Lab 01](../lab-01-pi-agent-loop/README.md))
- Conversation-scoped agent reuse or multi-turn context — every message gets a brand-new agent (that's [Lab 05](../ROADMAP.md))
- Concurrent user messages
- Real Teams tenant deployment, SSO, or persistence

## Architecture boundary

```text
src/
  booking-repository.ts   fixture lookup, copied from Lab 01
  get-booking-tool.ts      the one tool, copied from Lab 01
  create-agent.ts          builds a fresh Pi Agent for one request
  pi-trace-logger.ts        Indented agent/turn/tool tree logger, every line tagged [Pi][req:<id>]
  agent-runner.ts          the AgentRunner boundary — never rejects
  teams-trace-logger.ts     Teams lifecycle logging, prefixed [Teams][req:<id>]
  message-handler.ts        pure delegation: trace + call the runner
  create-app.ts             Teams App wiring: ctx -> message-handler -> ctx.reply
  index.ts                  process entrypoint
```

The `AgentRunner` interface is the one boundary this lab is really about:

```typescript
interface AgentRunner {
  run(input: { text: string; requestId: string }): Promise<{ answer: string }>;
}
```

`createPiAgentRunner()` is the real implementation, wrapping the Lab 01 agent. It **guarantees it never throws** — a bad provider config, an unresolvable model, or an unexpected exception from `agent.prompt()` are all caught inside `run()` and turned into one fixed `INFRASTRUCTURE_ERROR_ANSWER` string. The Teams handler in `create-app.ts` never has to know the difference between a successful answer, a bounded "booking not found" answer (produced *inside* Pi's own tool-error handling), and a caught infrastructure failure — it just sends back whatever string `AgentRunner.run()` returns.

`message-handler.ts` holds the delegation logic (trace the inbound activity, call the runner) as a plain async function with no Teams SDK dependency, so it can be unit-tested with a fake `AgentRunner` — mirroring how Lab 02 tested `formatEcho` without a live server. The real `AgentRunner` (actual DeepSeek calls) is only exercised in the live Playground smoke test below, never in `npm test`.

## Prerequisites

- Node.js 22.19 or newer
- npm
- A configured `.env` (copy `.env.example`; see [Lab 01](../lab-01-pi-agent-loop/README.md) for how to get a DeepSeek API key)

## 1. Predict before running

Write down your answers before starting anything:

1. Which log lines belong to Teams and which belong to Pi, and how do you tell a matched pair apart in the console?
2. If `DEEPSEEK_API_KEY` is missing, at what point does the failure surface — inside `agent.prompt()`, as a thrown exception, or as `agent.state.errorMessage`? Where does `AgentRunner` catch it?
3. When you ask about `BK1001`, how many `[Pi][req:...]` turn_start lines do you expect before the Teams reply is sent?

## 2. Install dependencies

```bash
cd lab-03-teams-pi
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

## 3. Verify the deterministic parts

```bash
npm run check
```

This covers the booking fixture, the `get_booking` tool, the Teams trace formatting, and `message-handler.ts`'s delegation logic against a **fake** `AgentRunner` — plus one deterministic failure-injection test that points `createPiAgentRunner` at an unresolvable provider/model and asserts it returns the bounded infrastructure answer instead of throwing. None of this makes a network call.

## 4. Run the app

```bash
npm run dev
```

Expected output includes the same unauthenticated-request warning as Lab 02, since this lab still only talks to the local Agents Playground.

## 5. Run the Microsoft 365 Agents Playground

In a second terminal:

```bash
npm run playground
```

Open the printed Playground URL.

## 6. Happy path

Ask:

```text
What are the details for BK1001?
```

`pi-trace-logger.ts` renders the same indented agent/turn/tool tree as Lab 01's logger, with
every line tagged `[Pi][req:<id>]` — load-bearing here, since this server can have more than
one Teams activity in flight at once. Expected terminal trace (illustrative — the exact
wording of the final answer varies by model):

```text
[Teams][req:<id>] activity_received type=message conversation=<conv> text="What are the details for BK1001?"
[Pi][req:<id>] ▶ agent
[Pi][req:<id>]   ▶ turn #1
[Pi][req:<id>]     user       "What are the details for BK1001?"
[Pi][req:<id>]     [Assistant] I'll look that up.
[Pi][req:<id>]     ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}
[Pi][req:<id>]     ◀ tool_end get_booking status=success
[Pi][req:<id>]     toolResult get_booking status=success
[Pi][req:<id>]   ◀ turn_end #1 tool_results=1
[Pi][req:<id>]   ▶ turn #2
[Pi][req:<id>]     [Assistant] ...fixture-backed answer...
[Pi][req:<id>]   ◀ turn_end #2 tool_results=0
[Pi][req:<id>] ◀ agent_end
[Teams][req:<id>] reply_sent conversation=<conv> text="..."
```

Every line in this one request shares the same `req:<id>` — that's the correlation Lab 02 could not show, because it had no Pi layer to correlate against.

## 7. Inject a failure — unknown booking

Ask:

```text
What are the details for BK9999?
```

Observe that the tool reports an error inside Pi (`tool_end get_booking status=error`), and the final answer is a bounded "booking not found" statement, not a fabricated one. This never reaches `AgentRunner`'s own error path — it is handled entirely inside the Pi agent loop, exactly like Lab 01's `BAD_ID` case.

## 8. Inject a failure — missing provider configuration

Stop the app. Comment out `DEEPSEEK_API_KEY` in `.env` (or rename `PI_PROVIDER` to something invalid). Restart `npm run dev` and ask any question in the Playground.

Observe:

- The app does **not** crash — it keeps listening for the next message.
- The terminal shows a `[Pi][req:<id>] setup_error ...` or `provider_error ...` line, never a `handler_error` line — the failure was caught inside `agent-runner.ts`, before it ever reached the Teams handler.
- The Teams reply is the fixed infrastructure-error sentence, not a hang or a fabricated answer.

Restore `.env` afterward.

## 9. Explain the trace

Answer using your terminal output:

1. Which log line proves the Teams layer handed off to Pi, and which proves Pi handed a final answer back?
2. For the missing-provider case, why does the trace show `setup_error`/`provider_error` instead of `handler_error`? What would have to change in `agent-runner.ts` for a provider failure to instead surface as a `handler_error`?
3. Why does `create-app.ts` never need an `if (answer is an error) ...` branch?

## Completion criteria

- `npm run check` passes.
- A Playground request for `BK1001` produces an actual Pi lifecycle (`agent_start` ... `agent_end`) and exactly one Teams reply, correlated by one request ID.
- The `BK9999` reply is a bounded not-found statement, fixture-backed, not fabricated.
- Removing provider configuration keeps the transport alive and returns the fixed infrastructure answer, with evidence that the catch happened inside `agent-runner.ts` and not the Teams handler.
- You can trace one request across transport, runtime, tool, and response boundaries using only the console output.

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider errors and [Lab 02](../lab-02-teams-echo/README.md) for Playground connection issues — both apply unchanged here.

### `provider_error Connection error.` even though `DEEPSEEK_API_KEY` is set

`npm run dev` runs `node --use-env-proxy --import tsx src/index.ts` so that Node's `fetch` respects `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`, matching Lab 01's `npm run agent` script. If you invoke `src/index.ts` any other way (a custom script, a debugger launch config, `tsx` directly), add `--use-env-proxy` back or DeepSeek requests will bypass your proxy/VPN and fail to connect, even with a valid API key.
