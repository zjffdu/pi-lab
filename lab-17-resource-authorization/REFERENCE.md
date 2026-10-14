# Lab 17 — Reference explanation

Read after you have written (or waived) your prediction. It states outcomes.

## The prediction-gate scenario (`npm run demo:revocation`)

Yesterday alice (operator) changed BK1001; the conversation stored a tool offer containing both tools.
Today her `operator` role is revoked (she keeps `viewer`) and she reopens the session.

1. **The reopened conversation keeps the write tool in its stored offer.** `root({ agent: { tools } })` is
   honored only when the root is *created*; on a reopened session the conversation keeps the offer it stored.
   Observed directly: a process that passes both tools again still reads back whatever was stored
   (`restoredOffer` in `ChatResult`; `tests/create-harness.test.ts`). Left alone, yesterday's offer would
   silently be today's grant.
2. **`ChatService` overwrites it on every operation.** `resolveCapabilities` recomputes the tool list from
   today's roles; `openHarness` reads the stored offer (`restoredOffer`) and then calls
   `root.configure({ tools })`. The model is offered only `get_booking`. The change is visible in the
   model's own transcript as a system message with `toolsRemoved`, and in the trace as
   `system     tools -[update_booking_status]`.
3. **A write the model attempts anyway** (it saw the earlier turns) is answered by the harness with an error
   result whose diagnostic code is `tool_unavailable`. No decision is made, no request reaches the
   downstream, no business effect occurs. The refusal is *structural*, so the audit shows it as a capability
   record (tools = `get_booking`, roles = `viewer`), not as a `deny` decision, and the trace shows
   `⊘ tool_refused … code=tool_unavailable` with no `tool_start`.
4. **If the tool were offered anyway** (a stale conversation, a bug, a role-less path), `BookingService` still
   refuses: reason `no_role_grant`, audited, no effect, and the trace shows an ordinary `tool_start` ending
   `status=error code=tool_error` (`tests/runtime-authorization.test.ts`, "the capability gate is not the only
   gate"). The two lines are deliberately different.

## Findings worth keeping

- **Two gates, different jobs.** The capability gate decides what the model is *offered* (role level). The
  authorization gate decides what a *specific call* may do (role + tenant + owner + status), and runs on every
  execution regardless of what was offered.
- **Recovery uses today's offer — verified, not assumed.** After a real `SIGKILL` mid-write, with the role
  revoked, the process that resumes applies `configure({ tools })` *before* `harness.resume()`, and the model
  request of the recovered generation carries the narrowed offer (`tests/recovery.test.ts`). A positive control
  in the same file shows that with the role intact the recovered request does offer the write tool, so the
  narrowed list is not an artifact of the helper. `configure` does not start scheduling (`inspect()` still says
  `paused`), which is what makes the order possible.
- **Recovered execution is re-authorized because it goes through the same boundary.** A killed process left an
  in-flight `get_booking` (`replay: "safe"`); `resume()` runs it again, and with the booking reassigned in the
  meantime it is refused. A `replay: "unsafe"` write is *not* run again: recovery records an error result with
  code `interrupted`. What happened to that write is Lab 21's question.
- **A refusal is identified by its diagnostic code, not by a missing event.** A refused call emits
  `tool_execution_end` with no `tool_execution_start` — but so does a safe tool re-executed by recovery in the
  recovering process. The tracer classifies by the stored `code` (`tool_unavailable`, `invalid_arguments`,
  `blocked`, `interrupted`), and a test pins the safe-rerun case as *not* a refusal.
- **Pi 1.1 requests have no `tools` field — a test-design trap.** The model's tool declarations travel as
  `toolsAdded` / `toolsRemoved` on system messages in the transcript, so `context.tools` is `undefined`. A
  helper reading it yields `[]`, and every "the write tool was not offered" assertion would pass vacuously.
  The helper folds the system messages instead (`offeredToolsOf`, itself tested), and each "not offered"
  assertion has a positive control showing the same helper reports the tool as offered when it was.
- **Error text is not a contract; the code is.** The harness wraps a tool error as `<harness>[error] …`, and
  the 0.85.1 wording ("is unavailable", "outcome is unknown") is gone. Tests assert on the diagnostic code and
  use `toContain` for our own message.
- **A denial that names its reason is a leak.** "Missing", "another tenant", and "not yours" share one reason
  and one message. A caller with no role at all learns nothing about any resource (role is checked first).
- **The application holds no write handle.** `BookingReader` has no mutator; the only path to a status change
  is the connector → downstream, whose log and `statusChanges` are the ground truth for "was there an effect".
- **The downstream is a second enforcement point.** It trusts the token's `sub`/`tid`, not the application:
  calling the connector directly for a colleague's booking still fails (`not_found`).
- **The credential never leaves the connector.** Tests search the session files, audit log, provider requests,
  tool results, and now the trace for the issued token and its claims segment.
- **Audit failure fails closed.** Decisions are recorded before the effect; a throwing sink yields a tool error
  and no effect. A failing *capability* audit stops the request before any session or model call.
- **A booking with several containers is one resource.** Authorization, the audit record, and the status change
  are per booking, never per container. The leak checks use every container number plus the vessel as
  markers, and the two tenants' `BK1001` share none, so a partial leak (one container of two) would be caught.

## Known gaps and limits

- **History is not re-authorized.** A booking the caller has read stays in the session, and the next operation
  replays it to the provider even after ownership moved (`known gap — not fixed by this lab`). Revocation of
  already-derived content is Lab 19.
- **Structural refusals are not decision records.** A call to an unoffered tool leaves no `deny` row; the
  evidence is the capability record, the tool result the model saw, and the `⊘` trace line.
- **Decision-to-effect window.** Only a changed *status* is caught (`expectedStatus` → 409). A role revoked in
  that window is not.
- **The transcript still mentions the removed tool.** Pi 1.1 states the removal explicitly (`toolsRemoved`)
  rather than leaving the model to infer it, but this lab used a scripted provider only, so how a real
  provider handles a history that calls a tool it is no longer offered is unverified.
- **Local token issuer ≠ OBO.** No IdP, no consent, no token exchange, no clock skew, no rotation.
- **`pi-durable` is Experimental.** Everything above was verified against `1.1.0` only.

## Verification evidence (this run)

- `npm run check`: typecheck clean; 10 test files, 143 tests pass. Also from a clean copy after `npm ci`.
- Mutation checks (each applied temporarily, then reverted; suite re-run green afterwards). Failing tests:
  skip the offer reset (`configure`) → 6; drop the read authorization → 13; ignore ownership in policy → 12;
  drop the downstream owner check → 1; make the offer helper fold nothing → 10; classify a refusal by a missing
  `tool_start` instead of the code → 3.
- `npm run demo:revocation` output matches the scenario above, including the `system     tools -[…]` and
  `⊘ tool_refused … code=tool_unavailable` lines on day 2.
- Not independently reviewed: the same session that wrote the code also wrote the tests and these notes.

## Provenance notes

Copied byte-for-byte (SHA-256, first 12 hex): `security-context.ts` `7355f1e0fcf2` and `session-registry.ts` `6fcad0fbc64b`
from Lab 16, `transcript.ts` `55f4803ed172` from Lab 13. `session-store.ts` and `session-access.ts` are this lab's own and
were not compared with Lab 16's. Nothing imports from another lab.
