# Lab 10 — Context Compaction

English | [中文](README.zh-CN.md)

**Question:** how can the model read a shorter context while the session still holds the whole conversation?
**Answer this lab shows:** compaction changes what the *next request* carries, never what is *stored*.

- **Storage is append-only.** Compaction adds one `pi.compaction` entry. Every older entry stays, byte for byte.
- **The request is rebuilt.** The old prefix is replaced by a model-written summary; the newest turns stay verbatim.

Think of minutes of a long meeting: the full recording is kept, but the next person gets a one-page summary plus
the last few minutes word for word.

## A concrete scenario

You build a booking assistant. A planner asks about `BK1001` (two containers) and `BK1002`, and in the second turn
the assistant reports that `BK1002` has a customs hold — *missing phytosanitary certificate*. Six more turns of
small talk follow. The conversation is now about 2,000 tokens, and every new question re-sends all of it.

- **Without compaction**, every turn pays for the whole history, and a long enough session hits the context limit.
- **With it**, you compact once. The model gets a summary plus the last three turns. Asked *"which booking had an
  unusual note?"*, it still answers *BK1002, missing phytosanitary certificate* — from the summary.
- **But** a summary is the model's own retelling. In one run it wrote *"USLAX enforces phytosanitary requirements
  strictly"*: a guess the assistant made earlier and no tool ever returned, now stated as fact.

Who needs to understand this? **You, the developer**: when to compact, what to keep verbatim, and which facts must
never depend on a summary. The planner just sees a faster, cheaper assistant.

| In the scenario | In the lab |
| --- | --- |
| the customs hold, said once, early | `customsHoldReason` on `BK1002`, returned by `get_booking` in turn 2 |
| the one-page summary | the `pi.compaction` entry's `model` (a user message) |
| "the last few minutes, word for word" | the entries from the entry's `head` onward |
| the full recording | every older entry, still in storage |

## The idea

```text
entries:  U1 A1 T1 A1' | U2 … | … | U6 A6 | U7 A7 | U8 A8        (all stored, always)
                                   ^ head
next request = [ summary of everything before `head` ] + U6 … A8
```

`U` = user message, `A` = assistant message, `T` = tool result; `A1'` is the answer after the tool result.

Three takeaways:

1. **Compaction is a task, not a call.** `Conversation.compact()` returns a task id; the task asks the model for a
   summary; a write submission then places the entry. `compactConversation()` wraps the three steps.
2. **The cut is where `head` points.** The cut is chosen from a token budget (`keepRecentTokens`) and can land
   inside a turn. The demo computes the budget from the real transcript so the cut falls on a turn boundary.
3. **A summary can fail, and it is not retrieval.** If it runs out of tokens (`reserveTokens` too small) the task
   fails and writes nothing. If it succeeds, it can still carry the assistant's own guesses as facts.

Not covered: crash recovery (Lab 08), forks and navigation (Lab 11), retrieval or long-term memory.

## The experiment

`npm run demo:compaction` runs two scenarios against a live model, each on a fresh session with the same eight
turns. Turn 3 asks for the events of *every container of `BK1001`*, so one assistant message requests both.

1. Seed eight turns; measure the context.
2. `compact()` — `default` with no instructions, `instructed` with "preserve every identifier and hold".
3. Ask: *"which booking had an unusual note, and what was it?"*

## What we measured

From one live run (tokens: per-message estimate / the provider's own count for the request):

| scenario | entries | estimate before → after | provider before → after | hold recovered |
| --- | --- | --- | --- | --- |
| default | 26 → 27 | 1995 → 871 | 2468 → 1452 | yes |
| instructed | 26 → 27 | 2099 → 1007 | 2527 → 1607 | yes |

- **One entry added, none changed.** The first 26 entries are identical afterwards, and `head` is the turn-6 user
  entry. `context({ at })` rebuilds the old view.
- **The provider saves less than the estimate** (−36–41% vs −52–56%) because the system prompt and tool definitions
  are not compacted, and the summary itself costs several hundred tokens.
- **The default summary already kept the hold**, in all four live runs. This lab did *not* show custom instructions
  rescuing a fact the default would drop; to see that you need a fact a generic summary would call noise.
- **Identifiers are safe, claims are not.** Every booking and container number in the summaries exists in the
  fixtures (asserted); some claims came from the assistant's own earlier guesses.

The offline tests add what a live run cannot show safely: a summary cut off by the token limit fails the task and
writes nothing, a budget that covers the whole transcript compacts nothing, and the compacted context survives a
restart.

## Run it

```bash
cd lab-10-context-compaction
npm install
cp .env.example .env            # then fill in DEEPSEEK_API_KEY
npm run check                   # typecheck + 40 offline tests, no model calls
npm run demo:compaction         # the live experiment above
```

Try it by hand (one command = one turn, one compaction, or one read-only look):

```bash
npm run agent -- --session try --prompt "Look up booking BK1001 and list its containers."
npm run agent -- --session try --prompt "Which container is MSKU2345678 on?"
npm run agent -- --session try --compact --keep-turns 1 --custom-instructions "Keep every identifier and hold."
npm run agent -- --session try --inspect     # entries, head, context size, summary
grep -c MSKU2345678 session-data/try/main.jsonl   # still in storage after compaction
```

Reading the trace: `assistant (tool call) <name> call=<id> args=…` is what the model asked for; the
`tool_start`/`tool_end` pair below it is Pi running it, paired by `call=`. A message with two requests prints two
lines. Do not hand-edit `session-data/`.

## Test yourself

Before running the demo, write down your answers to 1–3; the rest after:

1. After compaction, which entries are still in storage, and which does the next request carry?
2. Where does the customs hold physically live after compaction?
3. Will the default summary keep it? What would make you doubt that?
4. Why is the provider's saving smaller than the estimate's?
5. Which lines of the trace are the model *requesting* a container, and which are Pi *running* it?
6. Why is a summary not a substitute for looking a fact up again?

(No learner prediction has been recorded for this lab.)

## Good to know

- **Pins:** `pi-durable`, `pi-ai`, `chord` `1.1.0`; `pi-durable` is experimental, so this was read from its types and
  then observed. Default model `deepseek-flash`.
- **Budgets:** `reserveTokens` is also the summary's output budget (80%). `300` and `1000` made the live summary
  hit its limit and fail; the lab defaults to `2000`. Automatic compaction is switched off.
- **Surprise, pinned by a test:** right after a compaction the system message comes *after* the newest user input
  in the request, although pi-durable's changelog says the baseline now leads. Cause not investigated.
- A cut inside a turn leaves an assistant answer without its question; there is no second summary for it.
- Provider problems: see [Lab 01](../lab-01-pi-agent-loop/README.md). If the demo fails on a token limit, raise
  `COMPACT_RESERVE_TOKENS`; if nothing compacts, lower `COMPACT_KEEP_RECENT_TOKENS` or pass `--keep-turns`.

## Where things are

```text
src/compaction.ts              compactConversation, keepRecentTokensForLastTurns, token estimates
src/create-harness.ts          registry, prompt, model selection, compaction policy
src/harness-trace-logger.ts    run/turn tree; request lines vs execution lines; compaction events
src/booking-repository.ts, container-event-repository.ts, get-*-tool.ts, session-store.ts, transcript.ts, cli.ts
scripts/compaction-demo.ts     the live experiment
tests/compaction.test.ts       the core offline proof (scripted model, real storage)
```
