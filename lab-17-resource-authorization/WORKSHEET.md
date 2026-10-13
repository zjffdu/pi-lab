# Lab 17 — Learner Worksheet

Fill this in yourself. Store your own words here; the reference explanation is in `REFERENCE.md`.

Prediction status: **waived** (the learner asked to skip it before implementation began, 2026-09-19).

## Prediction — a revoked permission and an old session

Yesterday an operator used the write tool in a session, so the session saved that tool as active.
Today the operator's write permission is revoked and they reopen the session. Does the model still
see the write tool? If it calls it anyway, what happens — is there a business effect? What does
the audit record?

_Your prediction:_ waived

## Observation

_What actually happened (after `npm run demo:revocation`)?_

## Explanation

_Why? Name the component that enforced each result — the capability gate, the resource
authorization, or the downstream service._

## Surprise

_What did you not expect?_

## Unresolved questions

_

## Transfer

_A changed scenario: an operator may now change a booking only while a second colleague is
"on call" for it. Which parts of this lab's design would need new server-side state, and where
would the check live — in the policy, the capability gate, or the downstream?_

## Completion states

| State | Status |
| --- | --- |
| Implementation verified | deterministic checks pass; Lab 15 skipped (not jointly verified) |
| Experiment verified | local experiments done; real OBO / live model not run |
| Learner completed | pending |
