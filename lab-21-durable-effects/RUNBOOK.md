# Lab 21 — Manual repair runbook

For outbox rows in `manual_review` (and for anything stuck in `unknown` that reconciliation cannot
finish). The application refuses to guess about these; this runbook is how a person decides. It uses
`npm run --silent outbox -- …` against the default schema; in production this would be an authenticated
operator console. The CLI's reviewer identity is a local test principal, not a real login.

## 0. Ground rules

- **Never edit `outbox`, `actions`, `approvals`, or `bookings` with SQL.** Triggers make the outbox and
  action request fields immutable and their terminal states final, and the audit trail (`outbox_events`,
  `action_events`) is append-only. `approvals` and `bookings` have no such triggers — SQL would be
  accepted there, and would silently break the guarantees built on them. Every legitimate change goes
  through the `review` command, which records who, what, and why.
- `list` and `show` are inspection-only and not tenant-scoped; `review` is tenant-scoped.
- **Never resend by hand to the receiver.** If a resend is justified, use `redeliver`, which puts the row
  back in the queue under its original idempotency key.
- The reviewer must be an approver in the row's tenant and **not** the requester.
- A written note is mandatory. Write what you checked and where.

## 1. Find what needs a decision

```bash
npm run --silent outbox -- list manual_review
npm run --silent outbox -- list unknown      # a row here for a long time means reconciliation cannot reach the receiver
npm run --silent outbox -- show <outboxId>   # the row and its full event trail
```

`review_reason` says why the application stopped:

| `review_reason` | What it means | What to check |
| --- | --- | --- |
| `receiver_has_neither_idempotency_nor_lookup` | An attempt's outcome was lost and the receiver cannot tell you or deduplicate | Look at the booking in the downstream system itself |
| `no_receiver_record_but_original_request_may_still_arrive` | Lookup found nothing, but the receiver does not deduplicate, so the original request might still land | Wait past the longest plausible network/queue delay, then look at the downstream booking again |
| `delivery_attempts_exhausted_outcome_unresolved` | The bound on deliveries was reached with the outcome still unknown | Look at the downstream booking; check the receiver's health |
| `reconciliation_exhausted` | The status interface was unreachable for every allowed lookup | Restore the receiver's status interface, then check the downstream booking |
| `lookup_result_does_not_match_request` | The receiver reported an effect for this key that differs from the request | Treat as an incident: the key may have been reused or the receiver's record is wrong |
| `retries_exhausted_after_unresolved_attempt` | The delivery cap was reached by a refused connection, but an earlier attempt was ambiguous, so the change may already exist | Look at the downstream booking first; do not assume `failed` |
| `receiver_reports_multiple_effects_for_this_key` | The receiver's lookup says it applied this key more than once | Treat as an incident: a duplicate effect exists downstream and needs correcting there |
| `receiver_reports_key_reuse_with_different_request` | The receiver says the key was used with different content | Treat as an incident, as for a lookup mismatch |
| `contract_violation_lookup_unsupported` | The application was configured to expect a lookup the receiver does not have | Fix the configuration or the receiver; then decide this row by hand |

## 2. Decide, from the downstream system's own state

Look at the booking **in the downstream system** (not in this application's local view — that view only
changes when a delivery is durably recorded, so it is exactly what is in doubt). Then:

- **The change is there** (status and version as requested):

  ```bash
  npm run --silent outbox -- review <tenant> <approver> applied <outboxId> <downstreamVersion> "checked <system> at <time>: BK… is <status> v<version>"
  ```

  The row becomes `succeeded`. The local booking view is moved to the version you report only if that
  is newer than the view's current version; the audit event says whether it moved (`localViewUpdated`).

- **The change is not there and you are sure it will not arrive** (the request cannot still be in flight):

  ```bash
  npm run --silent outbox -- review <tenant> <approver> not-applied <outboxId> "checked <system> at <time>: no change visible; queue drained"
  ```

  The row becomes `failed` (`manual_confirmed_not_applied`). Nothing is retried. If the business still
  wants the change, that is a **new proposal** and a new approval.

- **The change is not there and you want it delivered:**

  ```bash
  npm run --silent outbox -- review <tenant> <approver> redeliver <outboxId> "<why a resend is safe or acceptable>" --accept-duplicate-risk
  ```

  Without `--accept-duplicate-risk` the command refuses; with it, the acceptance is recorded. Use it only when (a) the receiver
  deduplicates by key, or (b) you have verified the effect is absent **and** cannot still arrive. With a
  receiver that does not deduplicate, a wrong call here applies the change twice.

## 3. After a repair

- `show <outboxId>` again: the event trail must contain `manual_confirmed_applied`,
  `manual_confirmed_not_applied`, or `manual_redeliver` with your note.
- A `redeliver` row goes back through the normal worker path; watch it reach `succeeded`, `failed`, or
  `manual_review` again.
- If a class of rows keeps landing here, the receiver contract is the problem (no idempotency, no lookup,
  or a lookup window shorter than your retry window) — fix that rather than resolving rows forever.

## 4. What this runbook does not cover

- A real downstream system: its own inspection tools, its retention window for idempotency records, and
  its support process are outside this lab.
- Rows stuck `in_flight` are not a manual case: when the lease expires a running worker sweeps them to
  `unknown` and reconciles. If no worker is running at all, start one.
