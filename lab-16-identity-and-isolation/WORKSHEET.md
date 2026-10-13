# Lab 16 — Learner Worksheet

Fill this in yourself. Write the **prediction** sections before running `npm run demo:isolation`
and before reading `REFERENCE.md` or the tests (the tests encode the answers). If you want to skip
a prediction, write `waived` in that section so the skip is recorded rather than left blank.

Prediction status: _pending_

## Prediction 1 — Two tenants, one booking number

Tenant A (alice) and tenant B (carol) each ask about `BK1001`, which exists in both tenants with
different contents. What does each get back? What does each provider request contain? What is in
the cache afterward?

_Your prediction:_

## Prediction 2 — Knowing a session ID

Bob (same tenant as alice) and carol (another tenant) both know the ID of alice's session. Is that
enough to read its history or continue it? What does each get back, and does a model call happen?

_Your prediction:_

## Prediction 3 — Invalid identity

An expired token, a wrong audience, and a forged `X-Tenant-Id` with no token at all: what status does each get,
and how many model calls happen?

_Your prediction:_

## Prediction 4 — A forged header next to a valid token

A valid tenant-A token plus `X-Tenant-Id: tenant-b`: whose data does the provider see?

_Your prediction:_

## Observation

_What actually happened (after running the demo)?_

## Explanation

_Why? Name the component that enforced each result._

## Surprise

_What did you not expect?_

## Unresolved questions

_

## Transfer

_A changed scenario: a shared team conversation that two employees in one tenant should both read.
Which parts of this lab's design stop working, and what new server-side state would you need?_

## Completion states

| State | Status |
| --- | --- |
| Implementation verified | see README |
| Experiment verified | pending |
| Learner completed | pending |
