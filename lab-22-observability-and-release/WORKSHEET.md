# Lab 22 — Learner Worksheet

Prediction status: _waived_ (recorded 2026-09-22, at the learner's explicit request, before any
implementation was written).

## Prediction gate

> Predict the release decision when unit tests pass but a live case leaks another tenant's data.
> Predict how missing required telemetry should affect that decision.

_Your prediction:_ waived.

## Reference answer (written after the waiver, for later comparison)

Passing unit tests says nothing about a live case's behavior — they are different evidence
layers (deterministic checks vs. bounded live evaluation), and this lab keeps them distinct on
purpose. A live case leaking another tenant's data is a critical authorization violation
regardless of what the unit tests show: `release-gate.ts` treats a critical invariant failure
(`no-cross-tenant-leak`, `critical: true`) as blocking on its own, with exit code 2 — see
`exitCodeFor` in [src/release-gate.ts](src/release-gate.ts) and the acceptance-criteria tests in
[tests/release-gate.test.ts](tests/release-gate.test.ts). Missing required telemetry is handled
the same way as a different, but equally blocking, category: `checkEvidence` in
[src/evidence.ts](src/evidence.ts) reports a case's expected-but-absent span as `missing_evidence`,
and `runReleaseGate` marks every `missing_evidence` reason `critical: true` — a case whose outcome
"looks fine" cannot pass if the evidence needed to trust that outcome was never recorded. Both
categories are reported separately from the other two (`infrastructure_failure`,
`semantic_below_threshold`) so a reviewer never has to guess which one actually blocked release.

## Observation

_What actually happened when you ran the commands under "Commands" in README.md?_

## Explanation

_Which module decided each part of the release-gate outcome (readiness, evidence, invariants,
metrics thresholds, judge calibration) — and what does each one **not** guarantee?_

## Surprise

_What did you not expect?_

## Unresolved questions

_

## Transfer

Changed scenario: a new case is added to `cases/held-out/` for a scenario this lab does not cover
(say, a document upload). Its invariant is written correctly, but the person adding it forgets to
list one of the stages it reaches in `expected.reachedStages`.

What actually happens to the release gate the next time it runs — does it pass, fail, or fail for
the wrong reason? Which module is responsible for that behavior, and is it the behavior you would
want in a real deployment? What would you change (in the case schema, in `evidence.ts`, or in the
authoring process) to make the *right* kind of mistake here loud instead of silent?

_Your answer:_
