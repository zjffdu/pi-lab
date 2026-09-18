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

The default configuration uses DeepSeek V4 Flash through the official DeepSeek API, same
as Lab 01, Lab 03, and Lab 04.

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

## 3. Verify the deterministic parts

```bash
npm run check
```

This covers the booking repository and tool (same as Lab 01), plus the session registry
(reuse, isolation, reset) and the conversation-tagged trace logger — entirely against
local fixtures and fake agents, no network calls.

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

Actual terminal trace from one recorded run (exact wording varies by model):

```text
[Setup] model=deepseek/deepseek-v4-flash
[Session] conversation=conversation-a created registry_size=1
[User][conversation-a] What are the details for booking BK1001?
[conversation-a] ▶ agent
[conversation-a]   ▶ turn #1
[conversation-a]     user       "What are the details for booking BK1001?"
[conversation-a]     [Assistant] I'll look up that booking for you.
[conversation-a]     ▶ tool_start get_booking call=call_00_YUA49... args={"bookingNo":"BK1001"}
[conversation-a]     ◀ tool_end get_booking status=success
[conversation-a]     toolResult get_booking status=success
[conversation-a]   ◀ turn_end #1 tool_results=1
[conversation-a]   ▶ turn #2
[conversation-a]     [Assistant] Booking BK1001 details:
- **Container:** MSKU1234567
...
[conversation-a]   ◀ turn_end #2 tool_results=0
[conversation-a] ◀ agent_end
[Session] conversation=conversation-a reused registry_size=1
[User][conversation-a] Which container is it using?
[conversation-a] ▶ agent
[conversation-a]   ▶ turn #3
[conversation-a]     user       "Which container is it using?"
[conversation-a]     [Assistant] Booking BK1001 uses container **MSKU1234567**.
[conversation-a]   ◀ turn_end #3 tool_results=0
[conversation-a] ◀ agent_end
[Session] conversation=conversation-b created registry_size=2
[User][conversation-b] Which container is it using?
[conversation-b] ▶ agent
[conversation-b]   ▶ turn #1
[conversation-b]     user       "Which container is it using?"
[conversation-b]     [Assistant] Which booking number do you mean? I don't have a booking established in this conversation yet.
[conversation-b]   ◀ turn_end #1 tool_results=0
[conversation-b] ◀ agent_end
```

Notice two things:

- The second `conversation-a` turn answers correctly **without calling `get_booking` again**
  — the container number is already in that agent's transcript from turn 1.
- `conversation-b`'s turn numbering restarts at `#1` and it has no idea what "it" refers to,
  even though it is asked the exact same question as `conversation-a`'s follow-up.

## 6. Inject a failure — process restart

Run only the follow-up, alone, in a brand-new process, reusing the same conversation id
`conversation-a` that already "knows" about BK1001 from step 4:

```bash
npm run agent -- --conversation conversation-a "Which container is it using?"
```

Expected: `[Session] conversation=conversation-a created registry_size=1` — **created**, not
reused, because this is a new process with an empty registry. The agent has no memory of
BK1001 and should ask which booking you mean instead of guessing a container number.

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
  tool result without re-calling `get_booking`.
- A different conversation id (`conversation-b`) asked the identical follow-up cannot see
  `conversation-a`'s transcript and does not fabricate an answer.
- Restarting the process and reusing `conversation-a`'s id produces a fresh agent with no
  memory of BK1001 — the loss of context is visible in the trace (`created`, not `reused`),
  not silently hidden.
- You can explain the difference between this lab's runtime message history (a `Map` in
  process memory) and durable persistence (nothing here survives a restart).

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider connection issues — they
apply unchanged here, including the `--use-env-proxy` requirement baked into `npm run agent`.
