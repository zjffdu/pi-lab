# Lab 21 — Learner Worksheet

Fill this in yourself. Write the **predictions** before running `npm run demo:effects` and before
reading the tests or the "Design and evidence" section of `README.md` (both encode the answers). If you
want to skip them, write `waived` in each section so the skip is recorded rather than left blank.

Prediction status: _pending_

## Prediction 1 — What a timeout proves

A delivery worker sends the approved change ("set BK1001 to on_hold") to the booking system and waits
3 seconds. No response arrives; the request times out.

1. Does the timeout prove the change did **not** happen? What could the booking system have done by
   the time the worker gave up?
2. The worker asks the booking system "did request `wb1-…` take effect?" and the answer is "no record".
   Does that settle it? Does your answer depend on whether the booking system deduplicates by the
   idempotency key? On whether the first request could still be arriving?
3. What should the application show the user while it does not know?

_Your prediction:_

## Prediction 2 — What lease expiry proves

Worker A claims an outbox row with a 30-second lease and then stalls (a long pause, a network partition).
The lease expires. Worker B claims the same row and finishes the delivery. A wakes up.

1. Does the expiry prove A has stopped? What is A about to do when it wakes up, and what stops it —
   and where (the application's database? the booking system?)?
2. If A's request reaches the booking system after B's, what is the business outcome under (a) a
   receiver that deduplicates by key, (b) a receiver that only checks fencing tokens, (c) neither?

_Your prediction:_

## Observation

_What actually happened (after running the demo)?_

## Explanation

_Why? Name the component that decided each result (idempotency key, outbox row, lease, fencing token,
receiver, reconciler, manual review) — and say what it does **not** guarantee._

## Surprise

_What did you not expect?_

## Unresolved questions

_

## Transfer

Changed scenario: the booking system now supports idempotency keys **but remembers them for only 24
hours**, and your outbox has a row stuck in `manual_review` that a person resolves with "redeliver" three
days after the first attempt. The original attempt did reach the booking system and was applied.

Which of this lab's guarantees still hold, which no longer do, and what would you add (to the receiver
contract, to the outbox, to the runbook)? Which layer of the effect report — attempts, business effects,
durable result — would have told you first?

_Your answer:_
