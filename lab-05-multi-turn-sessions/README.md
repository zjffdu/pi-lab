# Lab 05 — Multi-turn In-memory Sessions

English | [中文](README.zh-CN.md)

**Question:** how does a conversation id pick the right transcript for the next message?
**Answer this lab shows:** your code does, not Pi. Pi's `Agent` holds exactly one transcript and knows nothing
about conversation ids, so you keep a `Map<conversationId, Agent>` and look the agent up before every prompt:

- **Same id → same agent → same transcript.** The follow-up sees everything said before, including the tool result.
- **Different id → different agent.** It starts empty and sees nothing of the other conversation.
- **Restart → empty map.** The transcripts lived only in that process's memory, so even the same id starts over.

Think of one notebook per customer, kept in a drawer that is emptied every time the office closes.

## A concrete scenario

You run a booking assistant in a chat tool. Two colleagues talk to it at the same time, each in their own chat:

| Time | Chat | Message | What should happen |
| --- | --- | --- | --- |
| 10:00 | Chat A | "What are the details for booking BK1001?" | The assistant looks the booking up and answers. |
| 10:01 | Chat A | "Which container is it using?" | "it" means BK1001. It answers from the earlier lookup, with no new lookup. |
| 10:02 | Chat B | "Which container is it using?" | Chat B never mentioned a booking. It must ask which one, not borrow Chat A's. |
| 10:30 | server restarts | | Both notebooks are gone. |
| 10:31 | Chat A | "Which container is it using?" | Same chat id, but the assistant has lost BK1001. It must ask again, not guess. |

**Without a registry**, a new agent per message (Lab 03) makes the 10:01 follow-up fail: the second agent has never
heard of BK1001. **With one shared agent for everybody**, Chat B at 10:02 would answer with Chat A's containers.
Neither is acceptable, so something has to map "which chat is this" to "which transcript".

Who needs to understand this? **You, the developer.** The two colleagues just see an assistant that remembers, or
doesn't. The lab shows where the memory lives, who owns the lookup, and what a restart takes with it.

| In the scenario | In the lab |
| --- | --- |
| a chat | a conversation id (`conversation-a`, `conversation-b`) |
| the notebook | one `Agent` and its `agent.state.messages` |
| the drawer | `SessionRegistry`, a `Map` in `src/session-registry.ts` |
| the office closing | the process exiting; a new `npm run agent` starts with an empty map |

## The idea

```text
conversation-a ─┐                       ┌─ Agent A ── transcript A: system, user, assistant, toolResult, assistant, user, assistant
                ├─ registry.getOrCreate ┤
conversation-b ─┘                       └─ Agent B ── transcript B: system, user, assistant
```

Three things to take away:

1. **The registry is application code.** `pi-agent-core` exports `Agent`, the loop, and types; `Agent.sessionId` is
   only a string passed to the provider for caching. Nothing in Pi maps an id to an agent.
2. **History is just the agent's message array.** Every prompt sends the whole array to the model. A follow-up works
   because the earlier tool result is still in it; a new conversation works because its array is new.
3. **Nothing is durable.** No file, no database. A restart empties the map, and the trace says so (`created`, not
   `reused`) instead of hiding it.

Not covered: persistence across restarts, concurrent messages in one conversation (Lab 06), real chat transports
(Lab 03), authorization (who may open which conversation).

## The experiment

The CLI is an in-process harness: it runs a list of `(conversationId, message)` turns against one registry. Predict
first: what can the second message see, what can the other chat see, what survives a restart?

1. `npm run agent` runs the three turns of the table above (Chat A twice, then Chat B) in one process.
2. Run only the follow-up in a **new** process with the id `conversation-a`: that is the restart.

## What we measured

From live runs against `deepseek-flash` (wording varies by model; the registry and tool columns are what the trace showed):

| turn | conversation | registry | `get_booking` called | what the answer did |
| --- | --- | --- | --- | --- |
| 1 | `conversation-a` | `created`, size 1 | yes, once | listed BK1001's two containers |
| 2 | `conversation-a` | `reused`, size 1 | no | "uses two containers: MSKU1234567 and MSKU7654321" |
| 3 | `conversation-b` | `created`, size 2 | no | asked which booking number |
| restart | `conversation-a` | `created`, size 1 | no | asked which booking number |

- **The turn counter is the proof of reuse.** `conversation-a`'s follow-up is `turn #3`; `conversation-b` and the
  restarted `conversation-a` both start at `turn #1`. The counter lives in the logger subscribed to that agent and counts model calls (a tool call adds one), not user messages, which is why a second user message can be `turn #3`.
- **The follow-up needed no tool call** because the tool result was already in the transcript.
- **No answer invented a container.** The system prompt tells the model to ask when nothing has been established;
  that is a prompt behavior, so it can vary with the model.

The offline tests pin what a live run cannot show reliably (they drive the real `Agent` with a scripted stream):

- the follow-up's model call carries `system, user, assistant, toolResult, assistant, user`;
- the other conversation's first call carries only `system, user`;
- after `registry.reset()` the same id starts with `system, user` again.

## Run it

```bash
cd lab-05-multi-turn-sessions
npm install
cp .env.example .env     # then fill in DEEPSEEK_API_KEY
npm run check            # typecheck + 23 offline tests, no model calls
npm run agent            # the three-turn scenario above
```

Try it by hand:

```bash
npm run agent -- --conversation try "What are the details for booking BK1001?" --conversation try "How many containers does it have?"
npm run agent -- --conversation try "How many containers does it have?"   # new process: created, turn #1
```

Reading the trace: every line is tagged `[conversation-id]`. `assistant (tool call) ... call=<id>` is the model's
*request*; the `tool_start`/`tool_end` pair is Pi running it, and the `call=` id pairs them. Each `prompt()` opens its
own `▶ agent` ... `◀ agent_end` bracket, so one conversation shows several brackets.

## Test yourself

Answer the first three before running the scenario:

1. What can the second message in a conversation see that a brand-new conversation cannot?
2. What does a different conversation id see of the first one's history?
3. What survives a restart?
4. Which log line proves the follow-up reused the same agent?
5. Why does `conversation-b` start at `turn #1` even though it ran later?
6. The system message is in every transcript but never in the trace. Why?
7. If two chats shared one agent, which of the three outcomes in the table would break?

## Good to know

- **Pins:** `pi-agent-core` and `pi-ai` `1.1.0`. Default model `deepseek-flash`; a model id that is not in the pinned
  catalog fails at startup, and a test checks the default resolves.
- The system message carries the prompt and tool declarations. It is part of `agent.state.messages` and of every
  model call, but emits no `message_*` event, so the trace never shows it.
- `pi-durable` has conversations that survive restarts, with its own ids. From its README I could not find a lookup
  by an external chat id, so a real service would still keep this mapping; this was read, not run.
- Provider/connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md). `Unknown model` means `.env` sets a
  model id outside the catalog; keep `PI_MODEL=deepseek-flash`.

## Where things are

```text
src/session-registry.ts       Map<conversationId, Agent>: getOrCreate, has, size, reset
src/session-trace-logger.ts   agent/turn/tool tree tagged with the conversation id; turn counter per agent
src/create-agent.ts           model selection, system prompt, Agent; optional scripted streamFn
src/cli.ts                    runs (conversationId, message) turns against one registry
src/booking-repository.ts, get-booking-tool.ts   fixture lookup (a booking has one or more containers)
tests/session-agent-loop.test.ts   the core offline proof: reuse, isolation, reset against the real Agent
```
