# Lab 10 — Context Compaction

Labs 07-09 proved that a durable session keeps a complete, inspectable record of everything
that happened — every message, every tool call, every recovery. None of those labs ever asked
what the *model* actually sees on the next turn. This lab does: it seeds a long, deterministic
conversation, measures its real cost, runs Pi's own `lane.compact()`, and inspects exactly what
survives verbatim, what gets folded into a summary, and what the durable session still holds
that the model itself no longer receives.

## Learning objective

By the end of this lab, you can explain this from your own console output and evidence:

```text
durable branch entries (all of them, forever)
  -> compaction selects a cut point (oldest -> newest)
  -> summary entry (LLM-generated) + retained tail (verbatim recent messages)
  -> shorter provider context on the *next* request

full durable history remains inspectable
  (entries are never deleted — findEntries() still returns everything)
```

This lab extends [Lab 09](../lab-09-tool-replay-safety/README.md)'s `Session -> AgentHarness ->
lane("main")` stack with two read-only tools and one explicit `lane.compact()` call. It does
**not** cover session-tree navigation (Lab 11), vector retrieval/RAG/long-term memory, or model
benchmarking — and it does not treat a generated summary as lossless storage.

## Vocabulary (read before predicting)

- **`CompactionSettings`** (`{ enabled, reserveTokens, keepRecentTokens }`) — `reserveTokens` is
  *also* the summary's own output-token budget (`compact()` caps the model's summary generation
  at `0.8 * reserveTokens`, and a second "turn-prefix" summary, when needed, at
  `0.5 * reserveTokens`). `keepRecentTokens` is the approximate token budget for how much recent
  history stays verbatim. The harness's own built-in default
  (`DEFAULT_COMPACTION_SETTINGS`) is `{ reserveTokens: 16384, keepRecentTokens: 20000 }` — sized
  for a real, long-running agent against a 100k+ token context window. This lab passes its own,
  much smaller settings (see `compactionSettingsFromEnvironment` in
  [`src/create-harness.ts`](src/create-harness.ts)) so a short seeded conversation actually
  crosses a real cut point instead of being entirely "recent."
- **Cut point** — `findCutPoint()` walks backward from the newest entry, accumulating each
  message's estimated token cost (`estimateTokens()`, a `chars/4` heuristic — not a live
  tokenizer call) until it reaches `keepRecentTokens`, then snaps to the nearest valid boundary.
  A valid boundary is any `user` or `assistant` message — **not** only a turn start. If the cut
  lands on an assistant message (mid-turn), compaction treats it as a **split turn**: the
  turn's user question moves into a second, separate "turn-prefix" summary instead of the main
  history summary, and only the assistant's reply stays in the retained tail. This lab's demo
  script computes `keepRecentTokens` directly from the seeded transcript's own token costs
  specifically to avoid landing on a split turn — see section 5.
- **`CompactionEntry`** (`{ summary, retainedTail, tokensBefore, usage, fromHook }`) — the one
  new durable entry `lane.compact()` appends. `retainedTail` holds the actual, verbatim
  `AgentMessage[]` kept after the cut point. Nothing before it is deleted from the session; the
  entry is additive, same as every other entry type this roadmap has covered.
- **`lane.compact(options, context)`** — `AgentLane.compact({ customInstructions?}, context)`.
  With no `customInstructions`, the harness's default summarization prompt runs. With
  `customInstructions`, that text is appended to steer what the summary preserves — this lab's
  contrast case.

## Prerequisites

- Node.js 24.5 or newer
- npm
- Credentials for a model provider supported by `@earendil-works/pi-ai`

The default configuration uses DeepSeek V4 Flash through the official DeepSeek API, same as
every earlier lab.

## API note (revalidated against the pinned version)

Same pin as Labs 07-09: `@earendil-works/pi-agent-core@0.85.1`. Reverse-engineered from
`node_modules/@earendil-works/pi-agent-core/dist/harness/**/*.d.ts` and, for the exact cut-point
and split-turn behavior below, from `dist/harness/compaction/compaction.js` — not documented in
any `.d.ts`.

- `AgentLane.compact(options: { customInstructions?: string } | undefined, context):
  Promise<CompactionResult>` — `CompactionResult = Result<{ compaction: OperationResultRecord;
  run?: ... }, LaneBusy | NothingToCompact | Closed>`.
- `AgentHarnessOptions.compaction?: CompactionSettings` sets the harness's compaction
  configuration at `AgentHarness.create()` time; `harness.getCompactionSettings(context)` /
  `setCompactionSettings(settings, context)` read and change it afterward — this lab's demo
  script uses the setter to recompute `keepRecentTokens` from the actual seeded transcript
  before calling `compact()` (section 5).
- `findValidCutPoints()` (`compaction.js`) marks every `user`, `assistant`, `bashExecution`,
  `custom`, and `branchSummary`-role **message** as a valid cut point — `toolResult` messages
  are explicitly excluded. `findCutPoint()`'s backward token walk still *counts* `toolResult`
  tokens toward the budget; it just cannot cut a session in the middle of a tool result.
- `estimateContextTokens(messages)` is **usage-anchored**: it finds the last message in the
  array with a real, provider-reported `usage` and treats that as the token count for
  everything up to and including it, adding only a cheap heuristic estimate for anything after.
  This is accurate for a normal, growing conversation. It is **not** accurate immediately after
  compaction, when a `retainedTail` message carries over its original, pre-compaction
  `usage.totalTokens` (a *cumulative* count from before the cut) into a freshly reconstructed,
  much shorter context — see the measured artifact in section 5.

## 1. Predict before running

The roadmap's standard gate asks for a written prediction before the first real run. For this
lab, the learner explicitly asked to skip it (`跳过预测`) rather than write one — noted here
verbatim instead of fabricated after the fact, per the "no fake completion" rule this project
holds itself to. Sections 4-6 below are the real, first-run evidence with no prediction to check
it against.

## 2. Install dependencies

```bash
cd lab-10-context-compaction
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

## 3. Verify the deterministic parts

```bash
npm run check
```

This is `tsc --noEmit` plus Vitest across the booking and container-event repositories, session
lifecycle, environment parsing (model selection and compaction-settings defaults), and —the
core of this lab — `tests/compaction-mechanics.test.ts`.

That file is a deliberately **network-free** proof of the compaction mechanism itself:
`lane.appendMessage()` writes a realistic seven-turn transcript directly (same premise Lab
07-09's durability tests use — no model call), then feeds the resulting durable `Entry[]`
straight into `prepareCompaction()` — the exact pure, synchronous function the harness calls
internally before it ever asks a model to write a summary. It proves, without any live model
call:

- A large `keepRecentTokens` budget (`20000`, the harness default) selects **nothing** to
  summarize — the whole transcript is "recent."
- This lab's tiny `keepRecentTokens` budget (`120`) selects the early turns for summarization
  and leaves the later ones in `retainedTail` — and specifically, the fact
  `"missing phytosanitary certificate"` ends up in `messagesToSummarize`, not `retainedTail`.
- `prepareCompaction()` never mutates or drops the underlying durable entries it read.

Nothing in this section spawns a model request. `scripts/compaction-demo.ts`, next, is where the
one bounded live-model experiment happens.

## 4. Run the compaction demo (live evidence)

```bash
npm run demo:compaction
```

Two independent scenarios run back to back against the same eight-turn seeded conversation,
each its own fresh session id:

- **`default`** — `lane.compact(undefined, context)`, the harness's own default summarization
  prompt.
- **`instructed`** — `lane.compact({ customInstructions: "Explicitly preserve every booking
  identifier, container number, and any noted hold, exception, or evidence gap, even if it
  seems minor." }, context)`.

The seeded conversation (identical prompts in both scenarios):

```text
1. Look up booking BK1001 and tell me its route, vessel, and planned dates.
2. Now look up booking BK1002 as well. Flag anything unusual before we proceed.   <- the one
                                                                                     vulnerable
                                                                                     early fact:
                                                                                     BK1002's
                                                                                     customs hold
3. Check the container movement events for MSKU1234567 and summarize them briefly.
4. Check the container movement events for MSKU7654321 and summarize them briefly.
5. Given what you know so far, which of the two bookings looks more time-sensitive, and why?
6. If the customer asks for an ETA update tomorrow, what would you check first, in one sentence?
7. In one short sentence, what is the origin port for BK1001?
8. In one short sentence, what vessel does BK1002 use?
```

Turn 2 is deliberately this lab's *only* mention of BK1002's customs hold. Turns 5-8 are
deliberately short filler that never repeats it — real, current, but low-information recent
history, so a real cut point has to choose between "keep the recent filler" and "keep the
early fact."

Actual output from one recorded run (trimmed to the load-bearing lines):

```text
########## Scenario: default ##########
[User] Look up booking BK1001 and tell me its route, vessel, and planned dates.
[Assistant] Booking BK1001: CNSHA -> NLRTM, vessel MAERSK TEST, dep 2026-09-10, arr 2026-10-15,
container MSKU1234567. No hold flagged.
[User] Now look up booking BK1002 as well. Flag anything unusual before we proceed.
[Assistant] Booking BK1002:
- Route: SGSIN (Singapore) -> USLAX (Los Angeles)
- Vessel: MAERSK SECOND
- Planned departure: 2026-09-12
- Planned arrival: 2026-10-02
- Container: MSKU7654321
[!] Unusual: This booking has a customs hold - "missing phytosanitary certificate." That will
need to be resolved before the shipment can move. (BK1001 had no hold.)
... (turns 3-8: container events for both containers, a time-sensitivity comparison, three short
    filler turns) ...

=== Step 2: measure context before compaction (entries=24, lastRequestTokens=2127) ===
[Compaction] computed keepRecentTokens=100 to retain exactly the last 3 turns (reserveTokens stays 300)

=== Step 3: run lane.compact() (default settings) ===
[Compaction] tokensBefore=2136 retainedTail=6 summaryTokens=210 retainedTailTokens=100
             reconstructedContextTokens=310
             summary="## Goal
User is reviewing two bookings (BK1001, BK1002) ... to determine which booking is more
time-sensitive and flag anything unusual before proceeding.
## Progress
### Done
- [x] Looked up booking BK1001: ... No hold flagged.
- [x] Looked up booking BK1002: ... [!] Customs hold: "missing phytosanitary certificate."
- [x] Checked container events for MSKU1234567 (BK1001): GATE_IN ..."

=== Step 4: ask the follow-up question ===
[User] Earlier we discussed two bookings. Which one had an unusual note flagged, and what was
the note?
[Assistant] BK1002 - a customs hold for a "missing phytosanitary certificate."

########## Scenario: instructed ##########
... (identical eight seed turns) ...
=== Step 2: measure context before compaction (entries=24, lastRequestTokens=2289) ===
[Compaction] computed keepRecentTokens=124 to retain exactly the last 3 turns (reserveTokens stays 300)
=== Step 3: run lane.compact() with customInstructions="Explicitly preserve every booking
identifier, container number, and any noted hold, exception, or evidence gap, even if it seems
minor." ===
[Compaction] tokensBefore=2298 retainedTail=6 summaryTokens=221 retainedTailTokens=124
             reconstructedContextTokens=345
=== Step 4: ask the follow-up question ===
[Assistant] BK1002 - a customs hold note: "missing phytosanitary certificate."

########## Evidence summary ##########
┌─────────┬──────────────┬───────────────┬──────────────┬────────────────────────┬───────────────────────┬─────────────────────────────┐
│ (index) │ scenario     │ entriesBefore │ entriesAfter │ tokensBeforeCompaction │ reconstructedContextTokens │ followUpMentionsHold │
├─────────┼──────────────┼───────────────┼──────────────┼────────────────────────┼───────────────────────┼─────────────────────────────┤
│ 0       │ 'default'    │ 24            │ 25           │ 2136                   │ 310                    │ true                  │
│ 1       │ 'instructed' │ 24            │ 25           │ 2298                   │ 345                    │ true                  │
└─────────┴──────────────┴───────────────┴──────────────┴────────────────────────┴───────────────────────┴─────────────────────────────┘

=== All Lab 10 context-compaction assertions passed ===
```

## 5. Two measured findings worth reading closely

**Finding A — entries are never deleted, and the reconstructed context is ~85% smaller.**
`entriesBefore=24, entriesAfter=25` in both scenarios: `lane.compact()` added exactly one new
`CompactionEntry` and did not remove any of the 24 pre-compaction entries — `lane.findEntries()`
after compaction still returns all 25, and every original user, assistant, and tool-result
message is still there, byte for byte, in the session's own JSONL. What the *next request*
actually sends the model, though, is dramatically smaller: `reconstructedContextTokens` (the
summary text plus the verbatim `retainedTail`, measured with the same `estimateTokens()`
heuristic `findCutPoint` itself uses) is 310-345 tokens against a `tokensBefore` of 2136-2298 —
roughly an 85% reduction. This is the roadmap's core claim made concrete: **durable history and
model context are two different things**, and compaction only ever shrinks the second one.

**Finding B — `estimateContextTokens()` on the live post-compaction request is a misleading
number, and that is worth understanding, not hiding.** An earlier iteration of this script
measured "tokens in the next real request" a different way: hooking `transform_context` and
calling the harness's own `estimateContextTokens()` on the exact `AgentMessage[]` about to be
sent. That number came back *larger* after compaction than before it (evidence table column
`followUpRequestTokens_STALE_USAGE_ARTIFACT`: 2160 and 2322 — both *higher* than `tokensBefore`).
The reason is `estimateContextTokens()`'s own documented behavior: it anchors on the last message
in the array carrying a real provider-reported `usage`, and `retainedTail` messages keep their
*original* `usage.totalTokens` from when they first ran — a cumulative count of the *entire
pre-compaction conversation up to that point*, now sitting at the front of a freshly
reconstructed, much shorter context. The estimator has no way to know a compaction boundary sits
in front of it, so it (wrongly) treats that stale cumulative number as "tokens already spent in
this request." This is not a bug in this lab's code or a bug in Pi — it is a real, sharp edge in
reusing a usage-anchored helper across a compaction boundary, and it is why this lab's actual
before/after comparison (`reconstructedContextTokens` above) is computed directly from the
`CompactionEntry`'s own `summary` and `retainedTail` fields instead.

A third, smaller thing worth noting: an earlier five-turn version of this lab's seeded
conversation hit `isSplitTurn: true` — the cut point landed mid-turn, on an assistant message
instead of a user message, which makes `compact()` generate a *second*, separate "turn-prefix"
summary for the split turn's orphaned user question. That extra summary's own overhead, on a
short conversation, was large enough to erase the real savings from cutting the earlier turns.
`scripts/compaction-demo.ts` avoids this by computing `keepRecentTokens` directly from the
seeded transcript's own `estimateTokens()` costs (see `keepRecentTokensForLastTurns()`) so the
cut always lands exactly on a turn boundary — see the doc comment there for the derivation.

## 6. Inspect the evidence directly

```bash
find session-data -name '*.jsonl' | sort
```

Confirm by eye, on either scenario's session file:

- Filtering to `namespace: "pi.op.state"` shows a `compaction` operation with a durable
  `entryId`, appended after the eighth seeded turn's completed operation — not replacing it.
- The raw JSONL still contains the original `user` message *"Now look up booking BK1002 as
  well..."* and the original `toolResult` message with `customsHoldReason: "missing
  phytosanitary certificate"` from `get_booking`, unchanged, at their original sequence numbers.
- The new `compaction`-type entry's `summary` field is a plain string (Markdown-formatted, in
  this run) — Pi does not parse or structure it. `retainedTail` is a plain `AgentMessage[]` —
  the *exact* message objects from the tail of the conversation, not paraphrased.

Do not hand-edit these files. Delete `session-data/` and rerun `npm run demo:compaction` for a
fresh, fully reproducible pair of runs — wording will vary turn to turn (this is a live model),
but the entry counts, the "not deleted" property, and the large token reduction are stable.

## 7. Explain the trace

Answer using your own terminal output:

1. `entriesAfter` is always exactly `entriesBefore + 1`. What does that tell you about what
   `lane.compact()` actually does to the durable session, independent of anything about tokens
   or summaries?
2. The customs-hold fact was established in turn 2 and never repeated. `keepRecentTokens` was
   computed to keep only the last 3 turns verbatim. Why does the fact still show up correctly in
   both scenarios' follow-up answers, if it was not in the retained tail?
3. Section 5's `estimateContextTokens()` finding showed a helper giving a *technically accurate,
   practically misleading* number. What is the general lesson for using any token-accounting
   helper across a compaction (or navigation, or branch-summary) boundary, rather than assuming
   every helper in a package composes safely with every other one?
4. The `instructed` scenario's custom instructions explicitly named "any noted hold, exception,
   or evidence gap." In this run, the `default` scenario's summary preserved the hold anyway.
   Does that mean custom compaction instructions are unnecessary? What would you change about
   this lab's seeded conversation to construct a case where they are *not* redundant?
5. `prepareCompaction()`'s cut point can land on an assistant message and split a turn. What
   does Pi do differently in that case (see the vocabulary section and `compaction.js`'s
   `generateTurnPrefixSummary`), and why might that extra summary make compaction less
   effective specifically on a short conversation, even though it is exactly the same mechanism
   that makes compaction *more* effective on a genuinely long one?

## Completion criteria

- `npm run check` passes: repositories, session lifecycle, environment parsing, and the
  network-free compaction-mechanics tests proving the cut-point selection directly.
- `npm run demo:compaction` passes its own assertions on a live run for both scenarios: the
  durable entry count grows by exactly one, the reconstructed post-compaction context
  (`summary` + `retainedTail`, measured via `estimateTokens()`) is smaller than `tokensBefore`,
  and the `instructed` scenario's follow-up answer recovers the customs-hold fact.
- Provider context becomes smaller (measured directly from the `CompactionEntry`, ~85% smaller
  in the recorded run) while full durable history remains inspectable (`entriesAfter =
  entriesBefore + 1`, nothing removed).
- The summary never invented a shipment identifier or unsupported cause in any recorded run —
  every booking number, container number, port code, and date in both scenarios' summaries
  traces back to an actual tool result.
- The README does not claim `estimateContextTokens()` is safe to use across a compaction
  boundary — section 5 documents exactly where and why it is not.

## Project map

```text
src/booking-repository.ts             Lab 07/08/09's fixture repository, extended with an
                                       optional customsHoldReason — this lab's one vulnerable
                                       early fact
src/container-event-repository.ts     Lab 04/08/09's fixture repository (own copy)
src/get-booking-tool.ts               New: read-only, replay: "safe" (recovery is not this
                                       lab's concern, but a durable tool result still is)
src/get-container-events-tool.ts      New: read-only, replay: "safe", no artificial delay
src/session-store.ts                  JsonlSessionRepo wiring + create-or-reopen-by-id
src/create-harness.ts                 Model selection, both tools, and this lab's explicit
                                       (small) CompactionSettings
src/harness-trace-logger.ts           Indented run/turn/tool tree logger, with "compaction"
                                       as its own top-level span (sibling of "run", not
                                       nested inside it) and a flat transform_context
                                       observability hook (attachContextTokenHook)
src/cli.ts                            One invocation = one turn (--prompt), one manual
                                       compaction (--compact [--custom-instructions]), or one
                                       read-only inspection (--inspect)
scripts/compaction-demo.ts            The live-model experiment: seeds 8 turns, computes
                                       keepRecentTokens from the real transcript, runs
                                       lane.compact() twice (default vs. instructed), asserts
                                       and prints the evidence table
data/bookings.json                    Same fixture as Lab 05/07/08/09, plus BK1002's
                                       customsHoldReason
data/container-events.json            Same fixture as Lab 04/08/09
session-data/                         Durable JSONL sessions this lab writes (git-ignored)
tests/                                Deterministic, network-free tests — including
                                       compaction-mechanics.test.ts, the core proof
```

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider connection issues — they
apply unchanged here, including the `--use-env-proxy` requirement baked into `npm run agent`
and `npm run demo:compaction`.

If `npm run demo:compaction`'s assertions fail on `reconstructedContextTokens <
compaction.tokensBefore`, the seeded conversation likely was not long enough relative to
`reserveTokens` for this run's actual (live, variable-length) model responses — see section 5's
note on split turns and summary overhead. Increasing the number of short filler seed turns, or
lowering `COMPACT_RESERVE_TOKENS`, both push the ratio back in favor of a clear reduction.

If a follow-up answer does not mention the customs hold in the `default` scenario, that is not
necessarily a failure — see question 4 above — but the `instructed` scenario recovering it is
asserted, since that is the entire point of passing `customInstructions`.
