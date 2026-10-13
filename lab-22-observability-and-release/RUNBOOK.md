# Lab 22 — Reading and operating the release gate

For whoever runs `npm run release-gate` (in this lab, a learner at a terminal; in a real deployment,
CI or a release engineer) and needs to decide what a PASS or FAIL actually means before acting on it.

## 0. Ground rules

- **Never hand-edit `runtime-evidence/`.** Everything under it — traces, evaluation reports, release
  manifests — is evidence of one run, not source. If a run looks wrong, re-run it; don't patch its
  output.
- **Never loosen `config/release-thresholds.json` to make a failing run pass.** The whole point of
  freezing it before comparison is that a threshold change is itself a decision that needs its own
  review, on its own commit, before the next run — not a silent edit made to get past a specific
  red result.
- A release-gate `FAIL` with `critical: true` reasons is not something a threshold change can fix at
  all: those are authorization, approval, idempotency, or missing-evidence violations, and
  `release-gate.ts` deliberately does not compare them against any threshold.

## 1. Run it

```bash
npm run release-gate
```

Exit code:

| Exit | Meaning |
| --- | --- |
| `0` | PASS: every held-out case's invariants and evidence hold, and every threshold is met |
| `1` | FAIL, no critical reason: at least one non-critical threshold (task success, latency, semantic score, judge agreement) was missed |
| `2` | FAIL, at least one critical reason: an authorization/approval/idempotency violation or missing required evidence — the run cannot be released regardless of thresholds |

The console output lists every reason with its category (`infrastructure_failure`,
`missing_evidence`, `behavioral_failure`, `semantic_below_threshold`), whether it is `critical`, and
which case id it came from when it is case-specific.

## 2. Decide what a FAIL actually means

| Category | What it means | What to check |
| --- | --- | --- |
| `infrastructure_failure` | The gate could not even start on valid inputs (bad thresholds file, unreadable case registry, unreadable labels, unwritable evidence directory) | The specific reason string names the broken file; fix it and re-run — no case was evaluated |
| `missing_evidence` | An expected stage's span never showed up in the trace | Run `npm run trace -- <caseId>` (reads the newest `runtime-evidence/traces/run-<caseId>-*.jsonl`); if the stage is genuinely absent, the telemetry pipeline dropped it — the run's *outcome* may still be correct, but you cannot trust that without the evidence, so it still blocks |
| `behavioral_failure`, `critical: true` | An authorization, approval, or idempotency invariant failed | Read the reason's `detail` for the invariant id and what it found; trace back with `npm run trace -- <caseId>` to the exact span where the contract broke |
| `behavioral_failure`, `critical: false` | A non-critical invariant failed (for example, `no-invented-identifiers`), or an aggregate metric (task success, latency) missed its threshold | Same trace-based approach; not an automatic incident, but worth a look before the next release |
| `semantic_below_threshold` | A held-out case's answer scored below the semantic threshold, or the judge's agreement with human labels fell below its own threshold | If it is a case score: read the case's `semantic.rubric` and the answer in the trace. If it is the judge-agreement reason: the deterministic judge is not currently trustworthy enough to lean on — grow `judge/labels.json` before trusting semantic scores again |

## 3. Trace a failed case to its boundary

```bash
npm run trace -- <caseId>        # newest run as an indented span tree
# raw spans, if you need them: jq . runtime-evidence/traces/run-<caseId>-<epoch>.jsonl
```

Each line is one span (`stage/name`, `status`, then its attributes), indented under the span that called it; `✕` marks a denied or errored span, and `(orphan)` marks a span whose parent never made it into the file. Read them top to bottom — the stage
where `status` first turns `"denied"`, `"error"`, or diverges from what the case's
`expected.reachedStages` promised is the boundary responsible for the failure. `held-model-regression`
run with `simulate.regression: true` is the canonical example: the `policy` span's `authorized`
attribute is the first place the divergence is visible.

## 4. Graceful drain and rollback

- `npm run demo:drain` shows the shutdown-while-active contract: work started before `drain()` is
  called always finishes and produces a normal trace; work attempted after `drain()` has begun is
  rejected immediately, never silently queued and lost.
- `npm run demo:rollback` shows that reverting `config/release-thresholds.json` to a previous,
  compatible version is instantaneous and touches nothing else. It does **not** undo a business
  effect a case already produced (a receiver-ledger entry, an approval decision). If a released
  version's business effects need to be undone, that is a new, separately-approved compensating
  action against the downstream system — the same discipline Lab 21's own runbook uses for
  `manual_review` rows — never an implicit side effect of rolling back a config file.

## 5. What this runbook does not cover

- A real downstream system, a real approval database, or real Teams/Entra identity: out of scope
  for this lab (see README, "What this lab does and does not build on").
- The known evidence-check gap (under-declared `expected.reachedStages` in a case fixture passing
  silently): see README's "A known, deliberate gap" section and WORKSHEET.md's transfer question.
