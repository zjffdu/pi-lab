# Lab 17 — Resource Authorization and Delegated Access

English | [中文](README.zh-CN.md)

**Question:** may this signed-in employee do this action on this booking *right now*?
**Answer this lab shows:** it has to be decided again on every call, at two separate places:

- **What the model is offered.** Before each run, the tools offered to the model are recomputed from the user's
  roles *today*. A tool the user may not use is not offered at all.
- **What a call may do.** Even for an offered tool, every call is checked against the user's current role, the
  booking's owner and its current status, and written to an audit log *before* anything happens.

Think of it as a badge reader at the building door (which doors you even see) plus a guard at each room (whether
*this* room is yours, today).

## A concrete scenario

Alice is an operator in tenant A. She owns booking `BK1001` (two containers). Her colleague Bob owns `BK2001`.

| When | What happens |
| --- | --- |
| Monday | Alice asks the assistant to put `BK1001` on hold. It does. The session saves the conversation. |
| Tuesday morning | An administrator removes Alice's `operator` role. She keeps `viewer`. |
| Tuesday afternoon | Alice reopens Monday's session and says "cancel it". The history shows the model used a write tool yesterday. |

**Without this lab's approach**, the session remembers that the write tool was available, and a reopened session
quietly restores it: Alice keeps a permission she no longer has. The same trap exists for a run that was
interrupted by a crash and then resumed.

**With it:**

- Before the run, the offer is recomputed from today's roles and written over what the session stored. The model
  is offered only `get_booking`.
- The model still asks for `update_booking_status`, because yesterday's turns are in its history. The system
  answers "that tool is not available". Nothing reaches the booking system.
- If the tool *had* been offered by mistake, the second check still refuses: Alice has no role that allows it, and
  the refusal is written to the audit log.
- Asking for Bob's `BK2001` is refused with the same "no booking found" text as a booking that does not exist.

Who needs to understand this? **You, the developer.** Alice sees only "I could not cancel it". The lab shows where
the two checks live and why neither may rely on what the session remembers.

| In the scenario | In the lab |
| --- | --- |
| which tools Alice is offered today | `resolveCapabilities`, applied with `configure({ tools })` |
| what the session remembered | the stored offer, read back as `restoredOffer` |
| "may this call run?" | `BookingService` and the pure `decide()` in `policy.ts` |
| the record of the decision | the audit log (actor, roles, resource, action, policy version, decision) |
| the booking system's own check | the local downstream service, which re-checks tenant and owner from a token |

## The idea

```text
request ──► roles today ──► offer = tools those roles allow ──► configure() over the stored offer
                                                                      │
model asks for a tool ──► not offered?  ⊘ refused, nothing runs       │
                      └─► offered ──► BookingService: role + tenant + owner + status
                                          ├─ deny  → audit, error text to the model, no effect
                                          └─ allow → audit, then connector → downstream (delegated token)
```

Three things to take away:

1. **A session stores an offer, not a permission.** A reopened session keeps the tool list it saved; the offer
   must be replaced on every run, before any model call or resumed task.
2. **The offer is a convenience, the check is the guarantee.** Both gates are needed: the first stops a tool from
   being asked for, the second makes sure a call that gets through is still allowed.
3. **A booking with several containers is one resource.** Permission, audit and status change are per booking,
   never per container.

## The experiment

`npm run demo:revocation` replays the scenario above with a scripted model (no network). It prints each day's
trace, what the booking system changed, and the audit log. The roadmap's prediction was waived (see
[WORKSHEET.md](WORKSHEET.md)); [REFERENCE.md](REFERENCE.md) states the outcomes.

From one run:

| | Monday | Tuesday (same session, role revoked) |
| --- | --- | --- |
| stored offer when reopened | — | `get_booking`, `update_booking_status` |
| offered to the model | both tools | `get_booking` only |
| model's request | `update_booking_status` on `BK1001` | the same tool, on `BK1001` |
| result | success | `⊘ tool_refused … code=tool_unavailable` |
| booking-system changes | 1 | still 1 |
| audit decision records | 1 allow | none added (a capability record, roles `[viewer]`) |

- The refusal is *structural*, so there is no `deny` row: the evidence is the capability record and the `⊘` line.
- The 143 offline tests add what a demo cannot: a real `SIGKILL` mid-write followed by a resume, other tenants'
  and colleagues' bookings, a stale offer given to a viewer, a downstream token with the wrong audience, scope or
  expiry, and an unwritable audit log (the action does not happen).

Reading the trace:

| Line | Meaning |
| --- | --- |
| `assistant (tool call) <name> call=<id> args=<json>` | what the model asked for |
| `⊘ tool_refused … code=tool_unavailable` | not offered today; none of our code ran |
| `⊘ tool_refused … code=invalid_arguments` | arguments failed the schema (e.g. an invented `tenantId`) |
| `▶ tool_start` … `◀ tool_end status=error code=tool_error reason="…"` | offered and ran, then the check refused it |
| `system     tools +[…] -[…]` | a change in the offer |
| `↺ …` | began before a restart; `↺ tool_interrupted` was running when its process died and was not re-run |

## Run it

```bash
cd lab-17-resource-authorization
npm ci
npm run check             # typecheck + 143 offline tests, no model calls
npm run demo:revocation   # the scenario above
npm run manifest          # evidence manifest into runtime-evidence/
```

Try it by hand (each was run; the counts are what you should see):

```bash
npx vitest run tests/policy.test.ts                 # 36 passed: the role × resource × action matrix
npx vitest run tests/harness-trace-logger.test.ts   # 15 passed: every trace line above
npx vitest run -t "positive control"                # 1 passed: with the role intact, the write tool IS offered
npx vitest run -t "known gap"                       # 1 passed: old history is still replayed (see below)
```

## Test yourself

Answer 1–3 before running the demo:

1. After Alice reopens the session, which tools does the stored offer contain, and which does the model get?
2. The model asks for the write tool anyway. Does a decision record appear in the audit log? Why or why not?
3. How many status changes has the booking system seen at the end?
4. Why must the check at the call still exist when the offer is already correct?
5. Bob's booking and a booking that does not exist produce the same message. Why?
6. A crash left a read in flight, and the booking has since changed owner. What does the resumed run do?

## Good to know

- **Not established here:** real on-behalf-of token exchange (the delegated token comes from a local stand-in, so
  only audience, scope and delegation checks against a local mock are covered); real Teams/Entra identity; a live
  model; Lab 15's joint guarantees (that lab was skipped when this one was built).
- **Known gap, owned by Lab 19:** content already in a session is replayed to the model even after the user lost
  access to that booking. A characterization test pins it.
- **Not covered:** a role revoked *between* the decision and the effect (only a changed booking status is caught).
- **Roles live in memory** (`PermissionDirectory`). "Yesterday" in the tests is a fresh process with a changed
  directory over the same session files.
- **Principal:** tests and the demo mint a trusted `SecurityContext`; authentication was Lab 16.
- **Pins:** `pi-durable`, `pi-ai`, `chord` `1.1.0` (`pi-durable` is experimental, so this was observed on `1.1.0`
  only); `jose` `6.2.12`. Scripted provider only, so a real provider's handling of a history that names a tool it
  is no longer offered is untested.
- Copied, not imported: `security-context.ts` and `session-registry.ts` from Lab 16, `transcript.ts` from Lab 13.

## Where things are

```text
src/policy.ts                  roles, status transitions, policy version, pure decide()
src/policy-service.ts          current roles + resource -> decision -> audit (fails closed)
src/capability-resolver.ts     today's roles -> offered tool names
src/booking-service.ts         the one application boundary: authorize, then read / write
src/create-harness.ts          per-request registry; read stored offer, then configure() today's
src/chat-service.ts            capabilities -> session -> harness -> offer -> submit / resume
src/booking-connector.ts, delegation.ts, downstream-service.ts   delegated token and the local booking system
src/harness-trace-logger.ts    the trace tree
src/directory.ts, booking-store.ts, audit-log.ts, session-*.ts, app.ts
scripts/revocation-demo.ts     the experiment;  scripts/crash-child.ts  killed mid-tool by the recovery tests
tests/                         143 tests; start with runtime-authorization.test.ts and recovery.test.ts
data/directory.json            synthetic principals, roles, bookings (both tenants own BK1001)
```
