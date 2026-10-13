# Lab 21 — Durable External Effects

English | [中文](README.zh-CN.md)

If a downstream system completes an action but its response is lost, how does the application avoid a
duplicate effect and determine the real outcome?

Roadmap: [ROADMAP-PHASE-3.md](../ROADMAP-PHASE-3.md), Lab 21 (two consecutive experiments in one lab).

## Read this first

- **Prediction gate.** Before reading past the "Prediction gate" heading below, record your predictions in
  [WORKSHEET.md](WORKSHEET.md) (or write `waived`). Everything after that heading describes the
  mechanisms and therefore gives the answers away, as do the tests, `npm run demo:effects`, and
  [RUNBOOK.md](RUNBOOK.md)'s table. There is no `REFERENCE.md` yet: it is written after the predictions
  are recorded.
- **Prerequisites and what is claimed.** The roadmap lists Lab 18's approved actions, Lab 20's connector
  contracts, and local PostgreSQL.
  - **Lab 18** is the source of the action / approval / digest / state-machine code, **copied** into this
    lab (hashes of the originals in [SOURCES.sha256](SOURCES.sha256); Lab 18 itself is untouched). Changes
    are listed under "What was copied from Lab 18".
  - **Lab 20's connector code is not reused.** Its interface is read-only, and a write has different
    failure semantics. Its *lessons* are applied: a closed set of typed failure categories, exactly one
    retry owner, and honesty about what cancellation and timeouts cannot promise.
  - Labs 15 (joint runtime), 17 (resource authorization) and 19 (documents, provenance, egress) are **not**
    built on and **not** claimed here, as in Labs 18–20. Lab 18's deliberately tiny role check
    ([src/policy.ts](src/policy.ts)) stands in for Lab 17's policy.
- **No model, no Pi.** Nothing in this lab calls a model, so it has no Pi dependency and no live-model run.
  Pi's JSONL sessions are not touched (see "Storage and concurrency boundary").
- The receiver is a local stand-in. The tests establish what the *application* does against receivers
  with stated properties; they say nothing about how a real downstream system behaves.

## Scope

**Experiment A — delivery and reconciliation for one action**

- The approved action from Lab 18 is *admitted* in one PostgreSQL transaction that records the execution
  intent, consumes the approval, and inserts an outbox entry. Nothing is sent inside that transaction.
- A stable idempotency key is derived from the business action's identity and preserved across transport
  retries, reconciliation resends, and worker restarts.
- A local receiver with its own schema and its own transactions: idempotent by key, result lookup by key.
- Delivery outcomes are classified, and the outbox distinguishes `pending`, `in_flight`, `unknown`,
  `succeeded`, `failed`, and `manual_review`.
- Unknown outcomes are reconciled through the receiver's status interface before another delivery is
  considered; what cannot be decided goes to explicit manual review.

**Experiment B — multiple delivery workers**

- Workers (separate objects, and separate OS processes) claim outbox rows with leases and atomic
  conditional updates; every later write carries a fencing token.
- Injected lease expiry, worker crashes (including `SIGKILL`), and late responses from an old worker.
- Deduplication at the receiver; a fencing check at the receiver's write boundary in one contract variant.
- Bounded retries; `failed` (dead letter) and `manual_review` states.

Deliverables: outbox, delivery workers, local receiver, reconciler, named-checkpoint fault harness,
[manual-repair runbook](RUNBOOK.md), and a report that separates attempts, business effects, and durable
results.

Not covered: a real downstream system; shared multi-instance Pi sessions or transactional session append
(a later, dedicated lab); Lab 17's policy; Lab 19's content controls; real Teams/Entra approval UX; any
HTTP front door (the approval steps are service calls; `npm run outbox` is an operator CLI).

## Layout

```text
data/tenants.json               Lab 18's fixture + 12 extra tenant-a bookings (BK3001–BK3012) for concurrency tests
migrations/app/                 001/002: Lab 18's bookings, actions, approvals, events (changed); 003: outbox + outbox_events
migrations/receiver/001_...sql  the receiver's own tables: bookings, effects, idempotency keys, fences, request log
src/action-*.ts, policy.ts, ...  copied from Lab 18 (see below)
src/idempotency.ts              key derivation (a pure function of action ID + approved digest)
src/outbox.ts                   claims, lease sweep, and the fenced write (`settle`)
src/delivery-worker.ts          deliver + reconcile + decision rules; the only retry owner
src/receiver-client.ts          HTTP client, no retries; classifies every outcome
src/receiver/contract.ts        wire types, validators, and the ReceiverContract assumptions
src/receiver/server.ts          the local receiver (idempotency / lookup / fencing are switchable)
src/checkpoints.ts              named checkpoints and the fault plan
src/manual-review.ts            the only way to resolve a manual_review row
src/report.ts                   attempts / business effects / durable result, side by side
scripts/                        db-up/down, effects-demo, worker-process (a worker as an OS process), outbox-cli, write-manifest
tests/                          units, admission, delivery, faults, workers (incl. child processes), manual-review, review-findings (regressions from the independent review)
RUNBOOK.md                      manual repair procedure
WORKSHEET.md                    blank learner worksheet
```

### What was copied from Lab 18

Unchanged: `action-digest.ts`, `security-context.ts`, `directory.ts`, `migrations 002`. Changed:

- `action-state.ts`, `action-service.ts`, `migrations/app/001_init.sql`: `execute` → `admit`, state
  `executed` → `admitted`; the local `effects` table and the local booking update are gone; `admit()` writes
  an outbox row instead; a repeated call returns `already_admitted`; a checkpoint `admit.before_commit`.
- `policy.ts`: `mayResolveReview` added (approver, not the requester).
- `db.ts`: two migration sets (app and receiver), each reached through its own pool.
- `data/tenants.json`: 12 extra bookings.

## Commands

Run from this directory. Requires Node >= 24.5 (tested on Node v25.8.1, npm 11.11.0) and podman or docker
for the lab's Postgres.

```bash
npm ci
npm run db:up                 # starts container pi-lab-21-pg on 127.0.0.1:5545, writes DATABASE_URL to .env
npm run check                 # typecheck + all tests; needs the database, does not skip when it is missing
npm run demo:effects          # scenario table on throwaway schemas (record your predictions first)
npm run manifest              # writes runtime-evidence/manifest-<timestamp>.json
npm run db:down               # removes the container and its data
```

Each test file uses its own pair of throwaway schemas (one for the application, one for the receiver).
The multi-process tests start real `node` child processes (about 10 s each).

Operator CLI (see [RUNBOOK.md](RUNBOOK.md)):

```bash
npm run --silent outbox -- list manual_review
npm run --silent outbox -- show <outboxId>
```

---

## Prediction gate

**Stop here until you have recorded your predictions in [WORKSHEET.md](WORKSHEET.md) (or `waived`).**
The rest of this file states the design and the evidence.

---

## Design and evidence

### Three layers, never merged

| Layer | Question | Where it lives |
| --- | --- | --- |
| **Attempts** | How many times did the application try? How many requests reached the receiver? | `outbox_events` (claims, expiries, discards); the receiver's request log |
| **Business effects** | How many times did the downstream booking actually change? | The receiver's `receiver_effects` (ground truth — only the receiver knows) |
| **Durable result** | What has the application recorded as the outcome? | `outbox.status` + `result`, and the local `bookings` view |

[src/report.ts](src/report.ts) prints them side by side and flags disagreement (a duplicate effect, a
`succeeded` row with no effect). A `pending`, `in_flight`, `unknown`, or `manual_review` row is honest by
construction: it claims nothing it does not know.

### Admission (Experiment A, steps 1)

`ActionService.admit` runs, in one transaction, after a row lock on the action: role and policy checks →
approval deadline → digest recomputation → both parties' current roles → local resource version → consume
the approval → insert the outbox row (with its idempotency key and the immutable request) → record the
event → move the action to `admitted`. A crash at `admit.before_commit` rolls all of it back; a repeated or
simultaneous confirmation admits one row (`already_admitted`, backed by `outbox.action_id UNIQUE`). The
request never leaves the process inside this transaction.

### The idempotency key

`wb1-` + a hash of `(action ID, approved digest)`. It does not involve the worker, the attempt, the lease,
the fencing token, or the time, so every retry, reconciliation resend, and restart presents the same key,
and two different actions never share one.

### The outbox lifecycle

```text
pending --claim(deliver)--> in_flight --applied-------------------------> succeeded
   ^                          |  |  \--rejected / retries exhausted------> failed
   |                          |  \--connection refused (backoff)--------> pending
   |                          \--ambiguous | lease expired---------------> unknown
   |                                                                         |
   +----- reconcile: no record, receiver deduplicates by key -> resend -----+
          reconcile: receiver confirms ---> succeeded | failed
          reconcile: cannot decide safely --> manual_review --(a person)--> succeeded | failed | pending
```

`succeeded` and `failed` are terminal (a trigger enforces it). `failed` means "known not to have happened
and no further delivery planned" (`rejected_by_receiver`, or `retries_exhausted` — the dead letter). The
dead letter is reached only when **every** attempt was a refused connection: if any earlier attempt was
ambiguous or lost its lease, the cap goes to `manual_review` instead, because the effect may exist.

### What each outcome proves

| What the worker saw | Classified as | Proves the effect did not happen? |
| --- | --- | --- |
| 2xx with a valid `applied` body | `applied` | It says it did |
| 4xx with a valid `rejected` body | `rejected` | Yes — the receiver processed and refused |
| 409 `stale_fence` | `stale_fence` | Not applied *by this token*; the worker stops |
| Connection refused | `not_sent` | **Yes** — no bytes reached the receiver |
| Timeout, connection reset, 5xx, unreadable/unexpected body | `ambiguous` → `unknown` | **No** |
| Lease expired | `unknown` | **No** — not even that a request was sent |

### Reconciliation, by receiver contract

`ReceiverContract { idempotency: key | none, lookup, fencing }` is what the application *assumes*; it is
configuration, not discovery.

| Receiver | Lookup says | Decision |
| --- | --- | --- |
| lookup | applied | `succeeded` (source `reconciliation`), no resend |
| lookup | rejected | `failed` |
| lookup + idempotent | no record | resend under the same key (safe because of dedup) |
| lookup, **not** idempotent | no record | `manual_review` — the original may still arrive |
| no lookup, idempotent | — | resend under the same key |
| no lookup, **not** idempotent | — | `manual_review` |
| lookup unreachable | — | retry with backoff, bounded → `manual_review` |
| lookup disagrees with the request, or reports more than one effect for the key | — | `manual_review` (not trusted) |
| delivery answered "key reused with a different request" | — | `manual_review` |

A resend is refused once `maxDeliveryAttempts` is reached (`manual_review`), so total deliveries are
bounded.

### Leases and fencing

- A **claim** is one atomic conditional `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`
  that also bumps `fencing_token`. Two workers never receive the same row.
- A **lease expiry** sends the row to `unknown`, not `pending`: it says the holder has not renewed, not
  that it stopped, and not whether it sent.
- Every write a worker makes is `UPDATE … WHERE id AND fencing_token AND lease_owner AND status`. A worker
  that lost its claim matches zero rows; its result is discarded and recorded as `stale_write_rejected`.
  The fence is the conjunction of token, owner, and expected status. A worker that stalled past its lease
  but whose row nobody has swept or re-claimed can still record its (true) result; once a sweep or a
  newer claim has moved the row, the write is discarded. The token is what distinguishes two claims of the
  same kind by the same worker ID (a restarted process); the sweep, driven by the clock, also participates.
  The owner check is redundant with the token (every claim raises it) and is kept as defense in depth.
- That fence protects the **application's** state. The **receiver's** write boundary is separate: in the
  `fencing` contract variant it refuses a token lower than one already accepted for the key. Fencing is
  not deduplication: a receiver that only checks tokens still applies the same request twice if the older
  token arrives first.
- The lease must outlive one receiver request (validated at construction).

### Checkpoints

| Checkpoint | A crash / fault here means |
| --- | --- |
| `admit.before_commit` | Approval consumed and outbox row inserted, not yet committed → rolled back |
| `worker.after_claim` | Lease held, nothing sent |
| `worker.before_send` / `worker.after_response` | About to call / answer in memory, nothing recorded |
| `worker.before_result_commit` | Same, immediately before the fenced write |
| `worker.after_result_commit` | Result durable |
| `receiver.before_apply` | Receiver read the request; `delay`, `http 503`, or `drop` here |
| `receiver.after_apply` | Effect committed at the receiver; `drop` or `http 503` here loses the response |

A plan installs faults by name (`Checkpoints`), or through the `FAULTS` environment variable for a child
process; `kill` sends `SIGKILL` to the process.

### Receiver assumptions behind each guarantee

| Guarantee (in the tests) | Holds only if the receiver… |
| --- | --- |
| Retries of one action create one business effect | deduplicates by the key (`idempotency: key`), on the same key and request |
| A lost response is resolved without a resend | offers a status lookup that reports effects by key |
| A stale worker cannot overwrite newer application state | — (enforced by the application's own database) |
| A stale worker's late request cannot double-apply | deduplicates by key, or validates fencing tokens and the older token arrives second |
| A resend after a timeout is safe | deduplicates by key |
| A row with no such receiver support is not blindly resent | — (the application routes it to a person) |

Tests that pin the *failure* when an assumption is wrong: `delivery.test.ts` ("assumed idempotent but the
receiver is not"), `workers.test.ts` ("fencing is not deduplication"), `manual-review.test.ts`
("redeliver … can double the effect").

### Acceptance criteria → evidence

| Roadmap criterion | Where it is checked |
| --- | --- |
| Under the receiver's idempotency contract, retries of the same action create one effect | `delivery.test.ts` (duplicate delivery, key reuse); `faults.test.ts` (every crash/loss case ends at one effect); `workers.test.ts` (concurrent claims, SIGKILL) |
| Unknown outcomes are neither shown as success nor blindly resent as failures | `faults.test.ts` ("response lost…", "timeout does not prove…"); `workers.test.ts` (neither idempotency nor lookup; bounded retries) |
| Stale workers cannot overwrite newer state | `workers.test.ts` ("lease expiry and a stale worker") |
| Unresolved outcomes have an inspectable manual-review path | `manual-review.test.ts`, [RUNBOOK.md](RUNBOOK.md), `npm run outbox` |
| Reports distinguish attempts, business effects, and durable results | `src/report.ts`; asserted in `delivery.test.ts`, `faults.test.ts`, `manual-review.test.ts` |
| Tests state the receiver assumptions behind each guarantee | The table above and the "assumption is wrong" tests |
| Admission is transactional; repeated confirmation admits one | `admission.test.ts` |

### Storage and concurrency boundary

Multiple workers here deliver business actions. Pi's JSONL sessions remain single-writer: leases over the
outbox do not make session files safe for concurrent access. This lab's outbox transaction does **not**
include Pi session writes, nor the receiver's own transaction — those are three separate commits, which is
exactly why the lost-response cases exist. Shared multi-instance sessions, transactional session append,
and session-backend migration need a later, dedicated lab based on verified public SDK interfaces.

### Known limitations

- Leases and backoff use the worker's own clock. Workers on different hosts with skewed clocks would
  shorten or lengthen leases; correctness of *state* is protected by the token, but promptness is not. A
  production version would take time from the database.
- Resolving a row as `confirmed_applied` records the reviewer's report but never moves the local view
  backwards; the audit event says whether the view moved.
- The receiver's lookup for a non-idempotent receiver reports the latest effect and the effect count; the
  count is what reveals a duplicate.
- The application's local booking view is only as fresh as the last durable result. The receiver's version
  precondition (`expectedVersion`) is what actually protects the remote booking: two actions approved
  against the same version can both be admitted, and the receiver lets one win.
- The receiver's idempotency records never expire here. A real one has a retention window; a resend after
  the window is the transfer question in the worksheet.
- Manual-review resolution trusts the reviewer's report of the downstream state (the note is the evidence).
- No real downstream system, and no live-model run (none applies).

### Evidence status

| Item | Status |
| --- | --- |
| Deterministic checks (`npm run check`) | 71 tests pass (Node v25.8.1, Postgres 16 container); 5 consecutive full runs stable after loosening two timing-sensitive tests |
| Two-process and SIGKILL experiments | part of the suite |
| Control-weakening (mutation) check | 35 controls weakened one at a time: 33 detected. 2 survive as equivalent mutants: ignoring `lease_owner` in the fenced write (redundant with the token, kept as defense in depth) and reading the oldest instead of the latest effect in the lookup (unreachable once `effectCount > 1` goes to review). Two initial survivors (token check; digest recheck at admission) led to new tests |
| Independent review | Done by a separate reviewer: 1 HIGH + 5 MEDIUM + 5 LOW. HIGH (a terminal `failed` after an earlier ambiguous attempt), the MEDIUMs, and 3 LOWs are fixed with regression tests (`review-findings.test.ts`); the fixes have not had a second independent review. Left as documented: the CLI's `list`/`show` are not tenant-scoped |
| Demo output / `REFERENCE.md` | withheld until predictions are recorded |
| Real downstream system | not run (pending; needs documented idempotency and lookup semantics) |
| Live model | not applicable |
