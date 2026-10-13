# Lab 01 — Observe the Pi Agent Loop

English | [中文](README.zh-CN.md)

**Question:** what does Pi do between a user's prompt, the model asking for a tool, and the model's final answer?
**Answer this lab shows:** the model never runs anything, it only *asks*. Two things make the loop work:

- **Pi executes the request.** When the model's reply contains a tool call, Pi runs your function and appends the
  result to the transcript as a `toolResult` message. The model's request and Pi's execution are two separate events,
  paired by a `call=` id.
- **Pi starts the next turn by itself.** A turn that ran a tool is followed by another turn that reads the updated
  transcript, with no new user message. The run ends at the first turn that asks for no tool.

Think of the model as a customer, Pi as a waiter, and the tool as the kitchen: the customer orders, the waiter fetches
the dish, and the customer decides what to say next.

## A concrete scenario

You build a booking assistant. A customer types *"What are the details for booking BK1001?"*. The model has never seen
`BK1001`, so without a tool it could only guess a vessel and container numbers, and it would sound confident.

With the loop:

1. **Turn #1.** The model answers nothing yet. It replies with a request: call `get_booking` with `{"bookingNo":"BK1001"}`.
2. Pi runs `get_booking` against `data/bookings.json` and appends the record to the transcript.
3. **Turn #2.** Holding the record, the model answers: containers `MSKU1234567` and `MSKU7654321`, vessel `MAERSK TEST`, and so on.
4. The customer asks about `BAD_ID`. The tool fails, Pi appends the error, and the model says it could not find the
   booking, with no invented details.
5. The provider key is wrong. The run ends in turn #1 with an error, and the CLI exits non-zero instead of printing an
   empty answer.

Who needs to understand this? **You, the developer.** The customer only sees the final answer; the trace is how you see
*why* the assistant said it.

| In the scenario | In the lab |
| --- | --- |
| the model asking for a lookup | the `assistant (tool call)` line |
| the lookup actually happening | `tool_start` / `tool_end` (`get_booking`) |
| the lookup result the model reads | the `toolResult` message |
| the second answer starting on its own | turn #2 |
| a lookup that finds nothing | `status=error`, then a "not found" answer |

## The idea

```text
user prompt ─▶ turn #1: model ─▶ tool-call request ─▶ Pi runs the tool ─▶ toolResult joins the transcript
                                                                                     │
                        final answer ◀─ turn #2: model reads the transcript ◀────────┘
```

Three things to take away:

1. **The request is not the execution.** `assistant (tool call)` is what the model asked for, with the arguments it
   chose. `tool_start`/`tool_end` is Pi doing it. If the model never asks, those lines never appear.
2. **The transcript is the state.** `agent.state.messages` is `system`, `user`, `assistant`, `toolResult`, `assistant`.
   The system message carries the prompt and the tool declarations and goes to the model on every call, but it emits no
   event, so the trace never shows it. Turn #2 prints no `user` line because no user message was added; its input is
   the transcript built in turn #1.
3. **Failures are ordinary messages.** A failing tool becomes a `toolResult` with `status=error`. A failing provider ends
   the run with an `assistant` message whose `stopReason` is `error`, and `agent.state.errorMessage` is set.

Not covered: Teams, more than one tool, persistence, parallel tools, steering.

## The experiment

Each prompt below runs the real agent against the live model once:

1. Look up a known booking (`BK1001`).
2. Look up an unknown one (`BAD_ID`).
3. Ask something that needs no lookup.
4. Run the first prompt with an invalid API key.

From one live run each (counted with a throwaway script, not part of the repo):

| prompt | turns | tool executions | transcript roles | answer names both containers | run ends in error |
| --- | --- | --- | --- | --- | --- |
| `BK1001` | 2 | 1 (success) | system, user, assistant, toolResult, assistant | yes | no |
| `BAD_ID` | 2 | 1 (error) | system, user, assistant, toolResult, assistant | no | no |
| "what is a shipping booking?" | 1 | 0 | system, user, assistant | no | no |
| `BK1001`, invalid key | 1 | 0 | system, user, assistant | — | yes (401), exit code 1 |

- **The turn count follows the model's choice**, not a fixed number: with no tool requested, the loop ends after one turn.
- **`BAD_ID` has exactly the shape of `BK1001`**; only the tool's status differs, and the answer carried no container number.
- **A failed provider call still ends cleanly**: the error is in the trace and in `agent.state.errorMessage`, and the CLI turns it into exit code 1.
- Wording differs between runs. Turn #1 sometimes has a short `[Assistant]` preamble before the tool-call line; the structure did not change.

The 21 offline tests add what a live run cannot pin down: they drive the real `Agent` with a scripted stream function and
assert the exact trace tree, the transcript roles, the tool-error path, and the provider-failure path, and they check
that the default model id resolves in the pinned catalog.

## Run it

```bash
cd lab-01-pi-agent-loop
npm install
cp .env.example .env            # then fill in DEEPSEEK_API_KEY
npm run check                   # typecheck + 21 offline tests, no model calls
npm run agent -- "What are the details for booking BK1001?"
```

Try it by hand:

```bash
npm run agent -- "What are the details for booking BAD_ID?"        # tool_end ... status=error, answer says not found
npm run agent -- "In one sentence, what is a shipping booking?"    # one turn, no tool lines
DEEPSEEK_API_KEY=invalid npm run agent -- "hi"; echo "exit=$?"     # assistant (error) 401 ..., exit=1
PI_MODEL=nope npm run agent -- "hi"                                # Unknown model deepseek/nope. Available ...
```

Reading the trace (call id and answer text elided): `▶`/`◀` open and close a span at the same indent.

```text
▶ agent
  ▶ turn #1
    user       "What are the details for booking BK1001?"
    assistant (tool call) get_booking call=call_00_... args={"bookingNo":"BK1001"}
    ▶ tool_start get_booking call=call_00_... args={"bookingNo":"BK1001"}
    ◀ tool_end get_booking status=success
    toolResult get_booking status=success
  ◀ turn_end #1 tool_results=1
  ▶ turn #2
    [Assistant] ...answer built from the record...
  ◀ turn_end #2 tool_results=0
◀ agent_end
```

## Test yourself

Before running the agent, write down your answers to 1–3; the rest after:

1. How many LLM turns do you expect for `BK1001`? For a question that needs no lookup?
2. Which line shows the model asking, which shows Pi executing, and what pairs them?
3. What should happen when the booking number does not exist?
4. Turn #2 has no `user` line. What does the model read in turn #2?
5. Which event proves Pi executed the tool rather than the model inventing data?
6. Why does `agent_end` come only after the final assistant response?

## Good to know

- **Pins:** `@earendil-works/pi-agent-core` and `pi-ai` `1.1.0`, Node 24.5 or newer. The default model is
  `deepseek-flash`; `npm run check` fails if that id stops resolving in the pinned catalog.
- **Other providers:** `PI_PROVIDER` and `PI_MODEL` in `.env` choose the model, and each provider reads its own key
  (for example `ANTHROPIC_API_KEY`). The catalog lists 42 providers; only DeepSeek was run live for this lab.
- **Privacy:** booking data stays in the local fixture, but the user prompt and the tool transcript are sent to the provider.
- **Proxy:** `npm run agent` starts Node with `--use-env-proxy`, so `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` apply.
  Without it, a proxied network made every run end in an error while this lab was measured.
- **One tool at a time:** `toolExecution: "sequential"` keeps the trace linear. Parallel execution is a later lab's topic.
- **Deterministic lookup:** only the model's decision to call the tool and its wording vary; the tool's answer does not.
- **Failures you may hit:**
  - `Unknown model deepseek/…` — keep `PI_PROVIDER=deepseek` and `PI_MODEL=deepseek-flash`.
  - `Provider is not configured: deepseek` — set `DEEPSEEK_API_KEY` in `.env`.
  - `401 … Authentication Fails` — the key is wrong; do not print it while debugging.
  - `Connection error.` — check that your proxy is running and `api.deepseek.com` is not in `NO_PROXY`.
- Never commit `.env`.

## Where things are

```text
src/booking-repository.ts  loads and validates data/bookings.json (a booking has one or more containers)
src/get-booking-tool.ts    the get_booking tool; an unknown booking throws, which Pi turns into a tool error
src/create-agent.ts        model choice, system prompt, Agent construction (optional scripted stream for tests)
src/trace-logger.ts        renders the event stream as the indented agent/turn/tool tree
src/cli.ts                 terminal entrypoint; exits non-zero when the provider failed
data/bookings.json         the one fixture booking, BK1001
tests/                     offline tests, including the real Agent driven by a scripted stream
```
