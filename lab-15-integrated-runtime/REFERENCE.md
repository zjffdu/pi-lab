# Lab 15 — Reference Explanations

Kept apart from `WORKSHEET.md` on purpose. The prediction gate (P1, P2) was **waived** by the learner, so these
explain results already observed; they are not an answer key the learner was graded against. The transfer
answers (T1–T3) should be attempted first.

These are written for the **Pi 1.1** version of the lab. The 0.85.1 version's numbers differed (for example 4
durable entries rather than 5, and a different spans vocabulary); nothing here was carried over without a test.

## P1 — what a policy-blocked call leaves behind

For `update_booking_status` with `newStatus: "cancelled"`, in a run where the model then answers:

- **Durable session entries: 5** — user, system (the prompt and tool declarations, written when the run
  starts), assistant (carrying the tool call), `pi.tool-result` with `isError: true` and diagnostic
  `code: "blocked"` (the reason is model-visible), final assistant.
- **Audit records: 1** — `before_tool / blocked`, carrying the request id, the session id, the conversation id,
  the tool task id, the call id, and a business-action id. There is no `after_tool` record: that hook does not
  run for a call that never executed.
- **Spans: 6** — one `lab.run`, two `lab.turn`, two `lab.ai.request`, and one `lab.tool` whose `outcome` is
  `refused` (Pi emits `tool_execution_end` with no `tool_execution_start`). The span says *refused*; only the
  audit says it was a policy decision.
- **Business effects: 0.**

## P2 — what the application must reapply after a reopen

Nothing about the following is stored in the session, so a reopen must supply all of it again:

- the extensions: the prompt, the governance extension (**both tools and their hooks**), and the egress backstop;
- the egress configuration (forbidden values) and the preflight;
- the telemetry bridge, the tracer, and the request bindings (event streams and in-memory state);
- the business data behind the tools (here an in-memory repository that reloads its fixture).

Two things go the other way. The **offered tool set is stored** in the conversation and *wins* over what the
application passes to `root({ agent })`, so it must be reconciled with `configure({ tools })` rather than
reapplied. And a case note's **projection is stored** in the entry at write time, so a reopen with no projector
still shows the model that note. Not tested: whether the stored model selection behaves like the tool set.

## T1 — a tool with no policy entry

If the tool lives in some other extension while governance is installed, the call goes through the same
`beforeTool` hook, the deny-by-default table has no entry for it, and it is **blocked**: outcome `blocked`, one
`before_tool / blocked` audit record whose reason says no policy is registered, no effect, `mechanism.ok` true
(the machinery worked). If it is merely left out of the offered tool set, the call is refused as `tool_unavailable`
*before any hook runs*: no audit record at all, no effect, and still not a mechanism failure. Both stop the effect;
the difference is the audit trail and the outcome. Leaving a tool unoffered is not governance — a tool that is
offered and unlisted would be blocked only because the table denies by default.

## T2 — a withdrawn tool on a resumed session

The composition root must act: it compares the stored offer with the current configuration and replaces it
(`runtime.toolSet`, written as a durable `configure` commit). Pi then writes a `toolsRemoved` delta into the next
`system` message, so the provider's declared tools no longer include it (the first system message alone still
lists it — fold the deltas). If the model asks for it anyway because history shows it using it, Pi refuses the call
as `tool_unavailable`: outcome `unavailable`, no audit record, no effect, and not a mechanism failure. Without
the reconciliation the stored set would win and the tool would still be offered.

## T3 — the audit store is down

Every **tool call** stops — reads included, because this lab governs reads too and a `beforeTool` audit failure
becomes a block (fail-closed). Plain conversation without tools keeps working. The remaining risk is `afterTool`:
if only the completion record fails to write, the effect has already happened and cannot be undone; Pi swallows the
throw and reports it through `onReport`, whose default is a no-op, so it is silent unless wired. `verifyMechanism`
then reports the missing record afterwards rather than preventing it.

## Appendix — findings of the earlier (Pi 0.85.1) version, re-tested on 1.1

Each 0.85.1 finding was re-tested on 1.1. **held** = same conclusion; **changed** = true in a different form;
**gone** = no longer applies.

| # | 0.85.1 finding | On 1.1 |
| --- | --- | --- |
| 1 | `usage` arrives after `message_end`, so Lab 14's bridge mis-attributes tokens | **gone** — the committed assistant message carries its usage; the span is built from `message_end` alone (test: each span's usage equals its own message's, with distinct values) |
| 2 | Run-id binding is correlation infrastructure, not governance | **changed** — there is no run id; the binding is per conversation, set by the composition root around `submit()` |
| 3 | Telemetry cannot tell "blocked" from "the tool failed" | **changed** — telemetry now says `refused` vs `result`, and Pi's `code` separates blocked / unavailable / invalid-arguments / tool-error; only the audit separates a policy *decision* from a policy *exception* (both end as `blocked`) |
| 4 | A failed run is not a run without effects | **held** |
| 5 | Exceptions become model-visible text | **held** (`Tool call blocked: policy bug` is stored as the tool result) |
| 6 | Governing the read tool means audit downtime stops reads too | **held** |
| 7 | `after_tool` is fail-open by construction | **held**, plus: the swallowed throw reaches `HarnessOptions.onReport`, whose **default is a no-op** — silent unless wired (it is, here) |
| 8 | Persisted lane configuration beats the application's | **changed** — the offered tool set is stored in the conversation's agent document; `root({ agent })` applies only at creation; `configure({ tools })` reconciles |
| 9 | Hooks live on the harness, not in the session | **changed** — they belong to registry extensions, not stored; and bundling the tools with their hooks makes a reopen without governance toolless instead of ungoverned |
| 10 | Withdrawing a tool is not the same as blocking it | **held**, now read from Pi's own `tool_unavailable` code instead of inferred from the active set |
| 11 | Reopening does not restore business state | **held** |
| 12 | Only one place can block a provider request, and only by stopping the harness | **changed** — **no** place can block; a throwing `beforeRequest` is reported and the request is sent anyway (tested). A returned replacement *does* apply, so the backstop withholds |
| 13 | Egress is two layers (preflight + backstop) | **changed** — three: write-time check, preflight, backstop. The preflight reads Pi's real `Conversation.context()` instead of mirroring it |
| 14 | A fault is not per-request | **gone** — the backstop does not fault the harness; a later request runs |
| 15 | A leak through a buggy projector is invisible to everything else | **held**; now flagged only if the backstop had to act |
| 16a | The business-action id names an attempt | **held** (a blocked call has one; the ledger is empty) |
| 16 | `entryProjectors` / `toProviderMessages` / egress config are create-time configuration | **changed** — hooks, tool code, and the egress config are not stored; **the projection is**: it is computed at write time and stored in the entry, so a reopen with no projector still shows the note |
| — | Limit: system prompt and tool schemas are not scanned | **gone** — Pi 1.1 puts them inside the request's `system` message, so they are scanned (and withheld) |
| — | Limit: `before_payload` not observed | **gone** — the hook does not exist in 1.1 |
| — | Limit: substring matching only; only one provider-error shape tested | **held** |

### New in 1.1

- **`requestId` is Pi's idempotency key.** A reused id on a conversation returns the *original* submission and
  never runs the new prompt — durably, across a restart. The composition root reports `deduplicated: true` and
  `mechanism.checked: false` instead of presenting an old answer as the new prompt's.
- **`wait()` on an unsettled submission resumes scheduling.** So a reused `requestId` whose submission is still
  queued or placed (in flight, or left by a crashed process) is **refused** (`request_unsettled`) rather than waited
  on — otherwise a recovery run could execute behind a result labelled `deduplicated`. Only a settled submission is
  deduplicated.
- **A provider failure is not an exception.** `submit().wait()` settles `unanswered` with `reason: "model_error"`;
  the answer is `record.answer`, so "the final answer, never a preamble" is supplied by Pi rather than inferred.
- **Reopening without the governance extension is fail-safe**, not fail-open (see step 3) — a property of Pi 1.1's
  registry model that this lab then deliberately relies on by bundling.
- **The tool set is written as deltas** (`toolsAdded` / `toolsRemoved`) in `system` messages, so the first system
  message alone is not the current set (`declaredTools` in the test support folds them).
- **The projection is decided once, at write time.** That makes "refuse to commit a leaky projection" the earliest
  and cheapest egress layer, and `revokeProjection` (an `edits` entry) the way to take one back without erasing it.
