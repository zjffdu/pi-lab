# Lab 20 — Connector Reliability and Execution Budgets

English | [中文](README.zh-CN.md)

> **Spoiler warning.** This README gives the answers. Record your prediction in [WORKSHEET.md](WORKSHEET.md) (or write
> `waived`) before reading on or running `npm run demo:faults`.

**Question:** when an external API is slow, rate-limited, malformed, or only partly successful, how does the
assistant finish bounded work and still describe the result accurately?
**Answer this lab shows:** by putting every decision about *whether to try again, how long to wait, and when to stop*
in application code, and by letting the application — not the model — say what is incomplete.

- **One owner for retries, with limits on everything.** Only the connector retries the booking API, and it does so
  from the failure's *category* (a 403 is never retried; a 429 is, after the wait the server asked for), inside a
  per-request, per-run, and deadline budget.
- **Honest results.** Totals and "cutoff passed" are computed from validated data; a partial listing never yields a
  total; an application note says what is missing whatever the model writes.

Think of a courier with a fixed number of delivery attempts per parcel and a manager who writes "not delivered" on
the slip, rather than trusting the courier to remember.

## A concrete scenario

An operator asks the assistant: *"What is the total container weight on `BK1001`, and has the document cutoff passed?"*
The booking service sits behind an HTTP API that lists five containers across three pages.

| What happens | Without this lab's approach | With it |
| --- | --- | --- |
| Page 2 returns `503` three times | The model calls the tool again and again; each call retries internally; the wait and the bill multiply | One owner retries, 3 attempts with short waits, then stops and reports `unavailable` |
| The API says `429`, `Retry-After: 2` | Sleeps blindly, or hammers the API | Waits exactly 2 s (if that fits the limits), then succeeds |
| The API says `403` | A retry loop that can never succeed | One request, reported as `forbidden` |
| Only 2 of 5 containers arrive | The model adds up what it has and states a total as fact | Total is `UNKNOWN`; the answer carries an application note saying the data is incomplete |
| The operator closes the tab | The run and the API request keep going | The abort reaches the open socket; the API sees the request abandoned |

Who needs to understand this? **You, the developer.** The operator sees a sentence saying what is and is not known; the
API owner sees fewer, better-behaved requests.

| In the scenario | In the lab |
| --- | --- |
| deciding to try again | `HttpBookingConnector.request`, driven by `FailureCategory` |
| the courier's attempt limit | `maxAttemptsPerRequest`, plus the run-wide attempt budget in `RunBudget` |
| the slip saying "not delivered" | `applicationNote` and `completeness` in the run result |
| the operator leaving | `root.abort()` → the tool's abort signal → `fetch` |

## The idea

```text
HTTP request ─ auth ─ admission queue (bounded) ─ ChatService ─ Pi run ─ lookup_booking ─ connector ─ booking API
                                                    │ budgets: turns, tool calls, pages, attempts, context, output, deadline
                                                    └ result: answer + completeness + budget usage + every HTTP attempt
```

1. **Retry by category, with ownership.** The booking API is retried only by the connector. Model calls are retried
   only by the harness (`settings.retry`, with the provider SDK's own retry pinned to 0). A model that calls the tool
   again draws on the same run-wide attempt budget, so retries cannot multiply.
2. **Reserve before you spend.** Each tool call, page, and HTTP attempt is reserved before it is sent. Exhaustion
   stops *new* work; it does not cancel or refund work already on the wire.
3. **Completeness is identity, not a count.** A booking has one or several containers (`containerNos`). A listing is
   complete only if its containers are exactly that set, so a swapped container is caught and a foreign one adds no
   weight.

Not covered: writes and unknown outcomes (Lab 21), real endpoints, Labs 15/17/18/19 (this lab copies identity
handling from Lab 19 and offers one read-only tool to any principal that has a role).

## The experiment

`npm run demo:faults` starts a local fake booking API (real HTTP, scripted faults) and a scripted model, and runs the
roadmap's failure injections through the whole path. No network, no live model.

## What we measured

From one run of the demo. "API requests" counts every request the fake API received for that one lookup (the booking
record plus up to three container pages).

| Injected fault | API requests | Waited | Result |
| --- | --- | --- | --- |
| `403` | 1 | – | `unavailable`, `forbidden`, 1 attempt |
| `429`, `Retry-After: 2`, then ok | 5 | 2000 ms | `complete` |
| `429`, `Retry-After: 30` | 1 | – | `unavailable`; stopped, wait exceeds budget; the server's 30 s reported |
| `503` twice, then ok | 6 | 10 + 20 ms | `complete` |
| `503` always | 3 | 10 + 20 ms | `unavailable`, 3 attempts |
| hanging request | 3 | 200 + 400 ms | `unavailable`, `timeout`; the API saw 3 abandoned requests |
| malformed JSON / missing field | 1 | – | `unavailable`, not retried |
| repeated pagination cursor | 3 | – | `partial`, 4 of 5 containers, total `null` |
| page 2 fails for good | 5 | 10 + 20 ms | `partial`, 2 of 5, total `null`, application note added |
| 1 tool call allowed, 2 asked | 4 | – | second call refused; `BK2001` never requested |
| client leaves mid-request | 1 | – | `cancelled`; the API saw the abort |
| client leaves, API already working | 1 | – | the API saw the abort; its work still finished |

- **A refusal (`403`) and a transient failure (`429`, `503`) behave differently**: one request versus up to three attempts.
- **Waits are bounded by the limits, not by the server.** A `Retry-After` of 2 s is honored; one of 30 s is not, and the
  server's figure is reported instead.
- **Partial never becomes a total.** Every `partial` row has `total=null`.
- **Cancellation reaches the socket but cannot undo work.** In the last row the API's work completed after the client
  left — harmless for a read, exactly the problem Lab 21 takes on.

The 167 offline tests add: a model that ignores the warning and states a total anyway is still flagged by the note; a
container swapped for a foreign one is detected although the count matches; an over-limit request leaves only as a
placeholder; the service credential appears in no trace line, provider request, response, or session file.

Not measured: a live model under these limits, and a real booking endpoint.

## Run it

```bash
cd lab-20-connector-reliability
npm ci
npm run check            # typecheck + 167 offline tests; no network, no live model
npm run demo:faults      # the experiment above
```

Try it by hand (each checked to pass):

```bash
npx vitest run tests/connector-failures.test.ts -t "403 and 429"        # same request: retried after 429, not after 403
npx vitest run tests/trace.test.ts -t "retry"                             # the trace of a retried call
npx vitest run tests/sdk-assumptions.test.ts -t "cancelling the Context"  # a cancelled wait does not cancel the run
npm run --silent token -- tenant-a alice                                  # a local test token, for npm run dev + curl
```

`npm run dev` (needs `DEEPSEEK_API_KEY` in `.env`; not run for this README) prints each request's trace. Shape of one
run; ids, tokens, and timings vary:

```text
▶ run
  ▶ turn #1
    assistant (tool call) lookup_booking call=… args={"bookingNo":"BK1001"} tokens=…
    ▶ tool_start lookup_booking call=… args={"bookingNo":"BK1001"}
      ↳ booking p1 try 1 rate_limited http=429 4ms
      ↳ booking p1 try 2 ok http=200 3ms waited=2000ms
      ↳ containers p1 try 1 ok http=200 3ms
    ◀ tool_end lookup_booking status=success
```

`assistant (tool call)` is the model's request; `▶ tool_start … ◀ tool_end` is the harness executing it; each `↳` row
is one HTTP attempt. `⊘ tool_refused … code=blocked` means a budget stopped the call before the connector was reached.
`■ stopped: …` is the application's reason a run ended early.

## Test yourself

Answer 1–3 before running the demo:

1. Should a `403` and a `429` cause the same retry behavior? What does each status tell the connector?
2. A client disconnects while a request is already on the wire. What does the application stop, and what can it not undo?
3. Three tool calls at three attempts each would be nine requests. What makes the run send fewer?
4. Why does a partial listing carry `total=null` rather than a lower-bound total?
5. A booking names five containers and the API lists five — can the listing still be incomplete?
6. The turn limit stops the run through `root.abort()`. Why is "no further model call is sent" only an observation?

## Good to know

- **Pins:** `pi-durable`, `pi-ai`, `chord` `1.1.0`; default model `deepseek-flash`. `pi-durable` is experimental.
- **Model-call limits are not dispatch guarantees.** No `pi-durable` hook can end a run, so the turn and context limits
  call `root.abort()`, which races the next request. The context limit therefore also replaces an over-limit request's
  messages with a one-line placeholder: no session content leaves, but the request itself may be sent.
- **Cancel with `root.abort()`**, never a cancelled `Context` given to `wait()` — that stops only the wait.
- **The context limit counts the whole session history.** Once a session is past it, every later request is
  `incomplete`; start a new session.
- Requests on one session are queued so they cannot fork its history; a session with unsettled work from a crash is
  refused rather than run behind it.
- Everything here is a scripted model against a local fake API. How a real model behaves at the limits, and how a real
  service behaves, is unmeasured. The deterministic suite was checked by disabling 81 controls one at a time: 79 were
  detected (one after adding a test), and the 2 survivors are a documented redundancy and a branch no test reaches.
- Provider/connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md).

## Where things are

```text
src/connector/http-connector.ts  the retry owner: categories, Retry-After, deadlines, cancel, pagination, identity check
src/connector/{errors,schemas,lookup,deadline,trace}.ts  failure taxonomy, validators, computed conclusions, attempt log
src/fake-api/server.ts           local booking API with scripted faults and its own request log
src/run-budget.ts, admission-queue.ts, usage-meter.ts, model-limits.ts   budgets, bounded queue, cost, output cap
src/create-harness.ts            per-request registry: tool + budget hooks; model-call retry ownership
src/chat-service.ts              per-session queue, run lifecycle, result classification, application note
src/harness-trace-logger.ts      the trace tree above
scripts/faults-demo.ts           the experiment
tests/                           connector-contract, connector-failures, http-runs, http-sessions, trace, sdk-assumptions, units
```
