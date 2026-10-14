# Lab 18 — Reference Explanations

Predictions were waived for this lab, but read this only after you have run
`npm run demo:approval` if you still want the observation to be yours. It states the expected
outcomes.

## 1. An old approval and changed arguments

The old approval authorizes nothing new. A changed request is a **new action** with a new digest
(the digest covers tenant, requester, booking, target status, reason, and resource version), and it
starts `pending`. Executing it returns `409 invalid_state`; approving it while presenting the *old*
digest returns `409 digest_mismatch`. The old action is unaffected and can still execute exactly as
approved — until something it depended on changes.

Two further ways an approval stops describing reality, both terminal (`invalidated`):

- The **booking's version moved** (another action executed first). Execution returns `409
  stale_resource`.
- The **stored arguments no longer match the approved digest** (only possible if something
  bypassed the immutability trigger). Execution recomputes the digest and returns `409
  digest_mismatch`.

Enforced by `action-digest.ts` (what is bound), the `actions_guard` trigger (immutability), and
`ActionService.execute` (recompute and version check under the row lock).

## 2. Two simultaneous confirmations

Exactly one executable business action. One request gets `200`; the others get `409
invalid_state` (state `executed`). The booking's version goes 1 → 2 once, and `effects` has one row.

Enforced by the row lock taken before any check: the second request blocks until the first commits,
then reads `executed`. If that logic were wrong, `effects.action_id` being a primary key would make
the second insert fail. The same holds for simultaneous *approvals* (one `approvals` row, thanks to
the lock plus `UNIQUE(action_id)`) and for an approve racing a reject (one decision wins).

## 3. Text that says "approved"

Nothing changes. A prompt or a tool `reason` reading "APPROVED by bob" produces a normal `pending`
proposal: zero approval rows, zero effects. An argument like `approvedBy` or `state` is rejected by
the tool schema (`additionalProperties: false`), so no proposal is even created. The model has no
approve/execute tool; a hallucinated call to one is an unknown tool and does nothing.

Enforced by the tool's schema, by the fact that approval exists only behind an authenticated
HTTP endpoint, and by `SecurityContext` being the only source of "who".

## 4. Refused approvals

| Caller | Result | Why |
| --- | --- | --- |
| Approver, wrong digest | `409 digest_mismatch` | must present the digest reviewed |
| The requester (operator only) | `403 forbidden` | not an approver |
| A viewer with no relation to the action | `404 not_found` | cannot see it |
| Another tenant's approver | `404 not_found` | tenant scope; same body as an unknown ID |
| An approver approving their own proposal | `403 self_approval` | separation of duties |

## 5. Restart, revoked role, expiry

- **Restart while pending:** the proposal, its digest, and its deadline are in Postgres, so a new
  server process sees `pending`, and the approval + execution then succeed.
- **Approver loses the role before execution:** `403 approver_no_longer_authorized`, no effect, and
  the action stays `approved` — restoring the role restores it (fail closed, reversible).
- **Approval unused past its window:** `409 expired`, state `expired`, no effect.

## Provenance notes

Labs 13 and 16 were untracked at copy time, so hashes identify the copied sources (first 16 of sha256): `security-context`
`7355f1e0fcf29278`, `authenticator` `21922a4b2de0f27d`, `session-registry` `6fcad0fbc64bea6b` (Lab 16); `transcript`
`55f4803ed1723cbe`, `harness-trace-logger` `f1969976dfab53aa` (Lab 13).
