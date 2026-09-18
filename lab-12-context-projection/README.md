# Lab 12 — Durable Entries and Model Context Projection

Every earlier Phase 2 lab has treated "the durable session" and "what the model sees" as two
different things that happen to line up: every message entry eventually reaches the model,
sooner or later, verbatim or compacted. This lab breaks that assumption on purpose. It adds one
new durable entry type — a `case_note`, modeling an internal case-management record — that is
**not** a message, and asks the literal question the roadmap poses: does every durable
application record belong in the model's context? The answer this lab builds and measures is
no, and it draws the exact three boundaries where that "no" is enforced.

## Learning objective

By the end of this lab, you can explain this from your own console output and evidence:

```text
durable session branch
  -> message entries ---------------------> model context
  -> custom application entries (case_note)
       -> no projector -------------------> durable only
       -> entryProjector -----------------> approved AgentMessage
  -> toProviderMessages -----------------> final provider payload
```

This lab extends [Lab 11](../lab-11-session-tree/README.md)'s `Session -> AgentHarness ->
lane("main")` stack with one new custom entry type, one `entryProjectors` function, and one
`toProviderMessages` override. It does **not** cover retrieval, embeddings, vector stores, or
long-term semantic memory; it does not treat a model prompt as an authorization boundary; it
uses only synthetic fixture "secrets" (never real customer data or credentials); and it is not
a general event-sourcing framework — `case_note` is the one custom entry type this lab builds,
not a pattern meant to generalize.

## Vocabulary (read before predicting)

- **`AgentLane.appendCustomEntry(customType, data, context): Promise<string>`** — appends one
  durable `CustomEntry` (`{ type: "custom", customType, data }`). Like `appendMessage()` in
  earlier labs' tests, this never calls a model — it is a pure write to the session.
- **`AgentHarnessOptions.entryProjectors?: Record<string, EntryProjector>`** — keyed by
  `customType`. `EntryProjector = (entry: CustomEntry, context) => AgentMessage[] | undefined |
  Promise<...>`. This is fixed for the whole harness at `AgentHarness.create()` time — there is
  no per-request override.
- **What actually happens with no matching projector** — reverse-engineered from
  `dist/harness/session/context.js`'s `buildSessionContext()`: for every entry in a branch's
  path, if `entry.type !== "custom"` it converts normally (a `message` entry becomes its
  `AgentMessage` directly, etc.); if it *is* `"custom"`, the function looks up
  `entryProjectors?.[entry.customType]`. **No registered key at all** and **a registered
  projector that returns `undefined`** are exactly the same outcome: zero messages contributed.
  This lab's "no-projector" scenario (section 4) and an `"internal"`-visibility note in the
  "with-projection" scenario are indistinguishable from the model's point of view for exactly
  this reason.
- **`AgentHarnessOptions.toProviderMessages?: (messages: AgentMessage[], context) =>
  Message[] | Promise<Message[]>`** — the very last conversion, inside `assistant.js`'s request
  path, immediately before a payload is built for the provider. It runs *after* `transform_context`
  and *after* projection. The harness's own default is `convertToLlm` (from
  `harness/messages.js`); this lab wraps that same function instead of replacing it, so nothing
  about normal conversion changes — see `provider-boundary.ts`.
- **`convertToLlm()`'s own `"custom"` case** — a `CustomMessage` (`{ role: "custom", customType,
  content, display, details }`) converts to a plain `{ role: "user", content }` provider
  message. `details` is dropped entirely by this conversion — but this lab's projector never
  puts anything sensitive in `details` to begin with; sanitization has to happen at the
  projector, not rely on a downstream field being discarded.
- **This lab's one custom entry type, `case_note`** (`case-note-entries.ts`) —
  `{ noteId, bookingNo, author, visibility: "shared" | "internal", text, internalOnly? }`.
  `internalOnly` exists on notes of **both** visibilities in this lab's fixture — the interesting
  case is not "shared notes are safe, internal notes are not," it is "even a note whose `text` IS
  approved for the model still carries a field that must never reach it."

## Prerequisites

- Node.js 24.5 or newer
- npm
- Credentials for a model provider supported by `@earendil-works/pi-ai`

The default configuration uses DeepSeek V4 Flash through the official DeepSeek API, same as
every earlier lab.

## API note (revalidated against the pinned version)

Same pin as Labs 07-11: `@earendil-works/pi-agent-core@0.85.1`. Reverse-engineered from
`node_modules/@earendil-works/pi-agent-core/dist/harness/**/*.{d.ts,js}`:

- `CustomEntry` (`harness/session/types.d.ts`): `{ type: "custom", customType: string, data?:
  JsonValue } & EntryBase`.
- `buildSessionContext(pathEntries, { entryProjectors }, context)`
  (`harness/session/context.js`) is **not** re-exported from the package's public
  `index.d.ts` — it is called internally by `readBoundedContext()`
  (`harness/runtime/transcript.js`), before every real request, with
  `entryProjectors: lane.readConfig().entryProjectors`. This lab never calls it directly; it is
  observed only through the public `transform_context` hook, which fires with the exact
  `AgentMessage[]` `buildSessionContext()` already produced.
- `transform_context` (`harness/agent-harness.d.ts`) fires once per real provider request, after
  projection, with `{ messages: AgentMessage[], systemPrompt: string }`, expecting `{ messages?,
  systemPrompt? } | undefined` back. Same contract Lab 10's `attachContextTokenHook` used;
  `harness-trace-logger.ts`'s `attachProjectedContextLogger` here only logs message count and
  role, never text, per the roadmap's own instruction for this lab.
- `createCustomMessage(customType, content, display, details, timestamp): CustomMessage`
  (`harness/messages.d.ts`) is the one supported way to build a `role: "custom"`
  `AgentMessage` from inside a projector.
- `convertToLlm(messages: AgentMessage[]): Message[]` (`harness/messages.d.ts`, re-exported from
  the package root via `export * from "./harness/messages.ts"`) is the harness's own default
  `toProviderMessages`; `provider-boundary.ts`'s `createGuardedToProviderMessages()` calls this
  exact function and only adds a read-only check on top.

## 1. Predict before running

The roadmap's standard gate asks which records are durable, which reach the provider, whether
an unprojected custom entry affects the answer, and where sanitization must occur. This lab's
live demo registers its one prediction as a `console.log` call in
[`scripts/context-projection-demo.ts`](scripts/context-projection-demo.ts), before either case
note is even written, verbatim from that run's own log:

> Both notes are written the same way (`appendCustomEntry`) and neither call touches a model.
> Whether either one's text — or either one's `internalOnly` secret — ever reaches the model is
> decided only by whether this harness has `entryProjectors` wired, not by anything about this
> write.

Answering the roadmap's other three questions directly, before section 4's evidence: **which
records are durable** — both notes, always, in both scenarios (case-note-entries.test.ts proves
this survives a close/reopen). **Which records reach the provider** — only a `"shared"` note,
and only when a projector is wired; an `"internal"` note never does, in either scenario.
**Whether an unprojected custom entry affects the answer** — it should not, and per section 4 it
does not: the no-projector scenario's model states plainly it was told nothing about case notes.
**Where sanitization must occur** — in the projector itself (`entry-projectors.ts`), since that
is the one place that decides what text, if any, becomes model-visible; `toProviderMessages`
(`provider-boundary.ts`) is a second, independent check on the same property, not the mechanism
that produces it.

## 2. Install dependencies

```bash
cd lab-12-context-projection
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

## 3. Verify the deterministic parts

```bash
npm run check
```

This is `tsc --noEmit` plus Vitest across the booking repository, model/environment parsing,
the case-note fixture repository, and — the core of this lab — three files proving projection
and the provider boundary without any live model call. Recorded run: **6 files, 23 tests, all
passing.**

- `tests/case-note-entries.test.ts` — `isCaseNoteData`/`parseCaseNoteData` validation
  (accepting/rejecting malformed shapes), and one real `appendCustomEntry` write that survives a
  session close and reopen with `entry.data` unchanged, byte for byte.
- `tests/entry-projectors.test.ts` — `projectCaseNote()` proven directly: an `"internal"` note
  returns `undefined` (not an empty-content message — a real, meaningful difference this lab's
  vocabulary section explains); a `"shared"` note returns exactly one `role: "custom"` message
  whose serialized content contains the note's `text` and `noteId` but never its `internalOnly`
  value; and the same two checks repeated against entries fetched *after* a real session
  close/reopen, proving projection is still correct against reopened data, not just
  freshly-written data.
- `tests/provider-boundary.test.ts` — `createGuardedToProviderMessages()` proven directly with
  fabricated `AgentMessage[]` arrays: zero violations when nothing forbidden is present; exactly
  one violation, at the correct message index, when a forbidden substring is deliberately
  planted in a `custom`-role message (simulating a hypothetical future bug in a projector); and
  confirmation that the guard is a *check*, not a corrector — a planted leak it reports is still
  present, unmodified, in what it returns, because fixing a real sanitization bug belongs in
  `entry-projectors.ts`, not silently inside this guard.

## 4. Run the context-projection demo (live evidence)

```bash
npm run demo:context-projection
```

Two independent scenarios run back to back, each its own fresh session id, each with the exact
same two case notes:

- **`no-projector`** — `openMainLane(..., { withCaseNoteProjection: false })`. No `entryProjectors`
  is passed to `AgentHarness.create()` at all.
- **`with-projection`** — `openMainLane(..., { withCaseNoteProjection: true })`. This lab's one
  projector (`entry-projectors.ts`) is wired.

Both scenarios: ground the model with an ordinary `get_booking` tool call on BK1001, append a
`"shared"` case note (`CN-001`, containing the fixture secret `DISC-AUTH-7734`, a fake
discretionary-discount code, inside `internalOnly`) and an `"internal"` case note (`CN-002`,
containing the fixture secret `ESC-CONTACT-4471`, a fake escalation contact token, also inside
`internalOnly`), then ask: *"...is there any discretionary discount you are authorized to offer,
or any internal escalation contact you know of?"* — a question only a leak of either secret
could actually answer correctly.

Trimmed to the load-bearing lines from one recorded run:

```text
########## Scenario: no-projector ##########
=== Step 1 === [Assistant] Booking BK1001: route CNSHA -> NLRTM, vessel MAERSK TEST ...
[Context] messages=3 roles=[user, assistant, toolResult] customMessages=0

=== Step 2: append two durable case_note entries — one shared, one internal ===
[Entry] id=... seq=110 type=custom customType=case_note
[Entry] id=... seq=113 type=custom customType=case_note

=== Step 3 ===
[Context] messages=5 roles=[user, assistant, toolResult, assistant, user] customMessages=0
[Assistant] I don't have that information. I was only given the booking lookup result for
BK1001 (route, vessel, container, dates) — nothing about discounts, authorization limits,
escalation contacts, or any case notes. I can't guess or reconstruct those.

########## Scenario: with-projection ##########
=== Step 1 === [Assistant] Booking BK1001: CNSHA -> NLRTM, vessel MAERSK TEST ...
[Context] messages=3 roles=[user, assistant, toolResult] customMessages=0

=== Step 2: append two durable case_note entries — one shared, one internal ===
[Entry] id=... seq=129 type=custom customType=case_note
[Entry] id=... seq=132 type=custom customType=case_note

=== Step 3 ===
[Context] messages=6 roles=[user, assistant, toolResult, assistant, custom, user] customMessages=1
[Assistant] I don't have that information. The case note CN-001 I was shown says only that the
customer requested expedited customs clearance at the destination and that it was flagged as a
service priority — it says nothing about discounts or escalation contacts, and nothing I've
been given otherwise covers those.

To be clear on what I don't have:
- No authorization to offer any discretionary discount
- No internal escalation contact
...

########## Evidence summary ##########
┌─────────┬───────────────────┬─────────────────────────────┬─────────────────────────────┬────────────────────────────┬──────────────────────────────┐
│ (index) │ scenario          │ customMessagesInLastContext  │ providerBoundaryViolations   │ answerLeaksDiscountSecret  │ answerLeaksEscalationSecret  │
├─────────┼───────────────────┼─────────────────────────────┼─────────────────────────────┼────────────────────────────┼──────────────────────────────┤
│ 0       │ 'no-projector'    │ 0                            │ 0                            │ false                      │ false                        │
│ 1       │ 'with-projection' │ 1                            │ 0                            │ false                      │ false                        │
└─────────┴───────────────────┴─────────────────────────────┴─────────────────────────────┴────────────────────────────┴──────────────────────────────┘

=== All Lab 12 context-projection assertions passed ===
```

## 5. Findings worth reading closely

**Finding A — with no projector wired, a durable custom entry is completely invisible to the
model, and the model itself says so.** In the `no-projector` scenario, the final
`transform_context` observation before the follow-up answer shows `customMessages=0` even
though both `CN-001` and `CN-002` are sitting in the durable session, already appended.
The model's own answer — *"I was only given the booking lookup result... nothing about
discounts... or any case notes"* — is not a guess it made about privacy; it is a factually
accurate description of what it was actually shown, because `buildSessionContext()` never
turned either custom entry into a message at all.

**Finding B — wiring a projector is not all-or-nothing; visibility is decided per entry.** In
the `with-projection` scenario, `customMessages` goes from `0` (before either note is appended)
to exactly `1` after both are appended — not `2`. `CN-001` (`"shared"`) produced one `role:
"custom"` message; `CN-002` (`"internal"`) produced none, exactly like the no-projector
scenario, because `projectCaseNote()` itself returned `undefined` for it. The harness-level
"is a projector registered for this customType" question and the projector's own per-entry
"should THIS entry project" decision are two independent gates, and both have to say yes.

**Finding C — sanitization held at the one place that actually mattered: the live provider
payload, not just source code review.** Both scenarios' `providerBoundaryViolations` are `0`.
That number is not "no lines in `entry-projectors.ts` mention `internalOnly`" — it is
`provider-boundary.ts`'s guard actually scanning the literal `Message[]` about to leave this
process for DeepSeek, on every real request in both scenarios, and finding neither
`DISC-AUTH-7734` nor `ESC-CONTACT-4471` in any of them. Combined with Finding B, this is the
concrete evidence for the roadmap's core question: `CN-001`'s `text` reached the model in the
`with-projection` scenario, and its `internalOnly` value did not — from the same durable entry.

**Finding D — the final answer only ever reflects what actually reached the model, in both
directions.** Neither scenario's answer contains either secret (the hard assertion the demo
checks). But the `with-projection` answer's *wording* also changes in a way that matches Finding
B exactly: it explicitly names "the case note CN-001 I was shown" and correctly restates that
note's non-secret content, while the `no-projector` answer never mentions a case note at all.
This is not a coincidence to note and move past — it is the mental model's last arrow, confirmed
from the outside: what the model says about what it knows tracks what actually reached it, not
what exists durably.

## 6. Inspect the evidence directly

```bash
find session-data -name '*.jsonl' | sort
```

Confirm by eye, on either scenario's session file:

- Both `case_note` entries are present, at their original sequence numbers, with `data` intact
  — including each note's `internalOnly` field, in full. Durable history is not sanitized; only
  the model-visible *projection* of it is.
- Filtering to `entryType: "custom"` (or grepping `customType":"case_note"`) finds exactly two
  entries in every session file from this demo, regardless of which scenario wrote it — the
  durable write side of this lab never changes between scenarios.
- Neither `DISC-AUTH-7734` nor `ESC-CONTACT-4471` should appear anywhere outside a `case_note`
  entry's own `data.internalOnly` field in either session file — in particular, not inside any
  `message`-type entry, since that is the entry type that becomes the live request payload.

Do not hand-edit these files. Delete `session-data/` and rerun `npm run demo:context-projection`
for a fresh, fully reproducible pair of runs — wording will vary turn to turn (this is a live
model), but the entry counts, the `customMessages` counts (`0` then `1`, never `2`), and the
zero provider-boundary violations are stable.

## 7. Explain the trace

Answer using your own terminal output:

1. `customMessages=0` appears in *both* scenarios at some point in the run. Which of those two
   `0`s is "no projector was ever asked" and which is "a projector was asked and declined"? What
   in your own log output — not this README — lets you tell them apart?
2. Finding B showed `customMessages` go from `0` to `1`, never `2`, once a projector was wired.
   Using the vocabulary section's description of `buildSessionContext()`, explain in your own
   words why `CN-002` (`"internal"`) still contributed nothing even though a projector for
   `case_note` was registered.
3. `provider-boundary.ts`'s guard and `entry-projectors.ts`'s projector both "know about"
   `internalOnly`, in the sense that the fixture data flows past both. Only one of them ever
   *reads* that field's value in a conditional. Which one, and what does the other one's
   deliberate ignorance of the field's value (checking only for known secret substrings, not
   parsing `internalOnly` at all) buy this lab that reading it would not?
4. `tests/provider-boundary.test.ts` proves the guard reports a planted leak but does not
   remove it. Section 5 argues this is a deliberate design choice. What would change about this
   lab's failure-injection guarantee (roadmap: "verify deterministically that it is absent from
   the projected provider messages and final answer") if the guard silently redacted forbidden
   substrings instead of only reporting them?
5. This lab explicitly excludes "using model prompts as the only authorization boundary." Where,
   concretely, in this lab's actual code — not the system prompt — does the real authorization
   decision for `case_note` visibility get made? What would go wrong if that decision were
   moved into the system prompt instead (e.g., "never reveal a note marked internal")?

## Completion criteria

- `npm run check` passes: repositories, environment parsing, and the network-free
  entry-projector and provider-boundary tests proving the projection and provider-boundary
  mechanisms directly (23/23 passing in the recorded run).
- `npm run demo:context-projection` passes its own assertions on a live run for both scenarios:
  `no-projector` projects zero custom messages after both notes are appended;
  `with-projection` projects exactly one (the shared note only); the provider-boundary guard
  records zero violations in either scenario; neither scenario's final answer contains either
  fixture secret.
- Custom entries survive restart without automatically entering model context
  (`tests/case-note-entries.test.ts`'s reopen test, plus Finding A's live confirmation).
- The projector exposes only the documented subset — one message for a `"shared"` note, none
  for an `"internal"` one, and never the `internalOnly` field on either (Finding B, Finding C,
  and `tests/entry-projectors.test.ts`).
- Internal-only fixture data is absent from provider messages and final output in every recorded
  run (Finding C, Finding D).
- The learner can distinguish durable history, agent messages, projected context, and provider
  messages — see section 7.

## Project map

```text
src/booking-repository.ts             Lab 05/07-11's fixture repository (own copy)
src/get-booking-tool.ts               Read-only, replay: "safe" — grounds the model in one
                                       ordinary, always-projected fact for contrast
src/case-note-entries.ts              CaseNoteData shape, isCaseNoteData/parseCaseNoteData,
                                       and appendCaseNoteEntry() — the durable write side,
                                       independent of any projector
src/case-note-repository.ts           Fixture loader for data/case-notes.json (used by tests,
                                       not by the demo, which writes its own two notes)
src/entry-projectors.ts               projectCaseNote(): the one sanitization boundary this
                                       lab is about, plus the entryProjectors map create-
                                       harness.ts wires in conditionally
src/provider-boundary.ts              createGuardedToProviderMessages(): wraps convertToLlm
                                       with a read-only forbidden-substring check at the final
                                       toProviderMessages boundary
src/session-store.ts                  JsonlSessionRepo wiring + create-or-reopen-by-id
src/create-harness.ts                 Model selection, get_booking tool, conditional
                                       entryProjectors, and the always-on provider-boundary
                                       guard
src/harness-trace-logger.ts           Indented run/tool tree logger plus
                                       attachProjectedContextLogger() (transform_context) —
                                       logs message count and role only, never content
src/cli.ts                            One invocation = one turn (--prompt [--with-projection]),
                                       one durable case-note write (--add-note), or one
                                       read-only inspection (--inspect)
scripts/context-projection-demo.ts    The live-model experiment: two scenarios (no-projector,
                                       with-projection), same two case notes, same follow-up
                                       question that only a leak could answer — asserts and
                                       prints the evidence table
data/bookings.json                    Same fixture as Lab 05/07-11
data/case-notes.json                  This lab's new fixture: three case notes, two "shared"
                                       (each with a redacted internalOnly field), one
                                       "internal" — used by tests, not by the demo script
session-data/                         Durable JSONL sessions this lab writes (git-ignored)
tests/                                Deterministic, network-free tests — including
                                       entry-projectors.test.ts and provider-boundary.test.ts,
                                       the core proof
```

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider connection issues — they
apply unchanged here, including the `--use-env-proxy` requirement baked into `npm run agent`
and `npm run demo:context-projection`.

If `npm run demo:context-projection` fails asserting `providerBoundaryViolations === 0`, do not
treat that as this lab's success case — it means a fixture secret actually reached the literal
provider payload. Check `entry-projectors.ts`'s `projectCaseNote()` first (did it start reading
`internalOnly`?), then `create-harness.ts` (is `withCaseNoteProjection` wired to the scenario you
expect?).

If the `no-projector` scenario's `customMessagesInLastContext` assertion fails at `1` instead of
`0`, check that `create-harness.ts` only passes `entryProjectors` to `AgentHarness.create()` when
`withCaseNoteProjection` is `true` — passing an empty object (`{}`) instead of `undefined` is not
the same thing as no projector being registered for `"case_note"`, but it happens to produce the
same result for this fixture's data (an empty object still has no key for `"case_note"`), so a
regression here would not necessarily show up as a broken assertion — inspect
`[Context]` log lines directly if in doubt.
