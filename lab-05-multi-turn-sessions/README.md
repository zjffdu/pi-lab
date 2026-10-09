# Lab 05 — Multi-turn In-memory Sessions

Give the Lab 01 agent loop a conversation identity. Instead of building one agent per
message, a `Map<conversationId, Agent>` registry decides whether to reuse an existing
in-memory transcript or start a new one — and shows exactly what a process restart erases.

## Learning objective

By the end of this lab, you can explain this from your own console output:

```text
conversation-a -> Agent A -> transcript A
conversation-b -> Agent B -> transcript B
```

The same conversation id always resolves to the same `Agent` instance for the life of the
process. A different conversation id gets its own instance with no visibility into the
first one's transcript. There is no database or file behind any of this — it is a plain
`Map` living in one process's heap.

This lab builds directly on [Lab 01](../lab-01-pi-agent-loop/README.md)'s agent loop and
uses the same single `get_booking` tool and fixture. It does not add Teams transport (see
[Lab 03](../lab-03-teams-pi/README.md)), more tools (see
[Lab 04](../lab-04-multi-tool-investigation/README.md)), or durable persistence — see
[Lab 06](../ROADMAP.md) and the roadmap's "After Lab 06" section for those.

## Prerequisites

- Node.js 24.5 or newer
- npm
- Credentials for a model provider supported by `@earendil-works/pi-ai`

The default configuration uses DeepSeek Flash through the official DeepSeek API, same as Lab 01.
The CLI starts Node with `--use-env-proxy`, so the DeepSeek client honors
`HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.

## 1. Predict before running

Write down your answers before starting the agent:

1. What can the second user message in the same conversation see that a brand-new
   conversation cannot?
2. What can a different conversation id see of the first conversation's history?
3. What happens to all of this if the process restarts between messages?

Do not inspect the expected trace yet.

## 2. Install dependencies

```bash
cd lab-05-multi-turn-sessions
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

The Pi dependencies are pinned to `1.1.0` so later SDK changes do not silently alter this lab. Pi `1.1.0` catalogs the model as `deepseek-flash`; leave `PI_MODEL` unset or set it to `deepseek-flash` in `.env`. `npm run check` fails if the default model id stops resolving in the pinned catalog.

## 3. Verify the deterministic parts

```bash
npm run check
```

This covers the booking repository and tool (same as Lab 01), plus the session registry
(reuse, isolation, reset) and the conversation-tagged trace logger. They also drive the real Pi
`Agent` through the registry with a scripted stream function, so the transcript a follow-up sees,
the isolation of another conversation, and the fresh transcript after a reset are checked against
Pi `1.1.0` itself — no network calls.

## 4. Run the default live scenario

```bash
npm run agent
```

This runs three turns in one process, driven by an in-process CLI harness (no Teams or
HTTP transport in this lab — see [Lab 03](../lab-03-teams-pi/README.md) for that):

```text
1. conversation-a: "What are the details for booking BK1001?"
2. conversation-a: "Which container is it using?"          (follow-up, same conversation)
3. conversation-b: "Which container is it using?"           (same question, new conversation)
```

You can also drive your own scenario:

```bash
npm run agent -- --conversation conversation-a "What are the details for booking BK1001?" --conversation conversation-a "Which container is it using?"
```

## 5. Happy path

`src/session-trace-logger.ts` renders the same indented agent/turn/tool tree as Lab 01's
logger, with every line still tagged `[conversationId]` — unlike later labs that drop that
tag, here it is load-bearing: it is what lets you tell, at a glance, that `turn #3` below
belongs to the *same* `conversation-a` as `turn #1`/`#2`, even though it opens a brand-new
`▶ agent`/`◀ agent_end` bracket (one per `prompt()` call, not one per agent lifetime).

Actual terminal trace from one recorded live run (call id and the final answer elided; exact wording varies by model):

```text
[Setup] model=deepseek/deepseek-flash
[Session] conversation=conversation-a created registry_size=1
[User][conversation-a] What are the details for booking BK1001?
[conversation-a] ▶ agent
[conversation-a]   ▶ turn #1
[conversation-a]     user       "What are the details for booking BK1001?"
[conversation-a]     [Assistant] I'll look that up.
[conversation-a]     assistant (tool call) get_booking call=call_00_WFyC... args={"bookingNo":"BK1001"}
[conversation-a]     ▶ tool_start get_booking call=call_00_WFyC... args={"bookingNo":"BK1001"}
[conversation-a]     ◀ tool_end get_booking status=success
[conversation-a]     toolResult get_booking status=success
[conversation-a]   ◀ turn_end #1 tool_results=1
[conversation-a]   ▶ turn #2
[conversation-a]     [Assistant] Booking BK1001 details:
- **Containers:** MSKU1234567, MSKU7654321
...
[conversation-a]   ◀ turn_end #2 tool_results=0
[conversation-a] ◀ agent_end
[Session] conversation=conversation-a reused registry_size=1
[User][conversation-a] Which container is it using?
[conversation-a] ▶ agent
[conversation-a]   ▶ turn #3
[conversation-a]     user       "Which container is it using?"
[conversation-a]     [Assistant] Booking BK1001 uses two containers: **MSKU1234567** and **MSKU7654321**.
[conversation-a]   ◀ turn_end #3 tool_results=0
[conversation-a] ◀ agent_end
[Session] conversation=conversation-b created registry_size=2
[User][conversation-b] Which container is it using?
[conversation-b] ▶ agent
[conversation-b]   ▶ turn #1
[conversation-b]     user       "Which container is it using?"
[conversation-b]     [Assistant] Which booking number are you referring to? I don't have a booking established in this conversation yet.
[conversation-b]   ◀ turn_end #1 tool_results=0
[conversation-b] ◀ agent_end
```

An `assistant (tool call) <name> call=<id> args=<json>` line is the model's *request*, with the arguments it chose; the `tool_start`/`tool_end` pair is Pi actually executing that call, and the `call=` id pairs the two. Whether turn #1 also prints an `[Assistant]` preamble line before it depends on the model.

Notice three things:

- The second `conversation-a` turn answers correctly **without calling `get_booking` again**
  — both container numbers (a booking can have several) are already in that agent's transcript from turn 1.
- `conversation-b`'s turn numbering restarts at `#1` and it has no idea what "it" refers to,
  even though it is asked the exact same question as `conversation-a`'s follow-up.
- Neither conversation's trace shows the `system` message at the head of its transcript, yet both
  model calls carry it — see [The transcript versus the trace](#the-transcript-versus-the-trace).

## 6. Inject a failure — process restart

Run only the follow-up, alone, in a brand-new process, reusing the same conversation id
`conversation-a` that already "knows" about BK1001 from step 4:

```bash
npm run agent -- --conversation conversation-a "Which container is it using?"
```

Recorded output (trimmed):

```text
[Session] conversation=conversation-a created registry_size=1
[conversation-a]   ▶ turn #1
[conversation-a]     [Assistant] I don't have a booking established yet in this conversation. Which booking number are you referring to?
```

`conversation-a` is **created**, not
reused, because this is a new process with an empty registry. The agent has no memory of
BK1001 and should ask which booking you mean instead of guessing container numbers.

This is the core lesson: reusing the same conversation id string across a restart does not
recover any state. The registry, and every transcript it held, lived only in the previous
process's memory and is gone.

## 7. Explain the trace

Answer using your terminal output:

1. Which log line proves that `conversation-a`'s second question reused the same agent
   instead of creating a new one?
2. Why does `conversation-b`'s turn counter start at `#1` even though it runs after
   `conversation-a` in the same process?
3. After the restart in step 6, what does the agent do instead of fabricating a container
   number? What in the system prompt causes that behavior?

## Completion criteria

- `npm run check` passes (booking repository/tool tests plus session registry reuse,
  isolation, and reset tests, plus the trace logger tests).
- A same-conversation follow-up (`conversation-a`, turn 2) answers using the first turn's
  tool result — all of BK1001's containers, since a booking can have several — without
  re-calling `get_booking`.
- A different conversation id (`conversation-b`) asked the identical follow-up cannot see
  `conversation-a`'s transcript and does not fabricate an answer.
- Restarting the process and reusing `conversation-a`'s id produces a fresh agent with no
  memory of BK1001 — the loss of context is visible in the trace (`created`, not `reused`),
  not silently hidden.
- You can explain the difference between this lab's runtime message history (a `Map` in
  process memory) and durable persistence (nothing here survives a restart).

## The transcript versus the trace

- **Each transcript starts with the system prompt.** `conversation-a`'s `agent.state.messages` is `system`, `user`, `assistant`, `toolResult`, `assistant`, then `user`, `assistant` after the follow-up; `conversation-b`'s is `system`, `user`, `assistant`. The system message carries the prompt and the tool declarations, and it is what the model receives on every call, together with the full history so far. It emits no `message_*` event, so it never appears in the trace tree. `tests/session-agent-loop.test.ts` asserts these role sequences offline.
- **The trace shows events, not the whole transcript.** Each `message_end` and each `tool_execution_*` event is printed once, when it happens. The follow-up in `conversation-a` prints no `get_booking` lines because it needed no new tool call; its input is the transcript built during the first prompt.
- **The turn counter and the `[conversation-a]` tag outlive one prompt.** Each `prompt()` opens its own `▶ agent` ... `◀ agent_end` bracket, but the logger is subscribed once per agent, so `turn #3` continues from `turn #2`. A restarted process starts a new agent and a new logger, so the counter restarts at `#1`.
- **Provider failures end the run with an `error` message.** The run ends with an `assistant` message whose `stopReason` is `error`, and `agent.state.errorMessage` is set, which is what makes the CLI exit non-zero.

## Troubleshooting

### `Unknown model provider/model`

Keep `PI_PROVIDER=deepseek` and `PI_MODEL=deepseek-flash` with the pinned Pi `1.1.0` dependencies.

### `Provider is not configured: deepseek`

Set `DEEPSEEK_API_KEY` in `.env`.

For other connection issues, see [Lab 01](../lab-01-pi-agent-loop/README.md#troubleshooting) — they apply unchanged here.
