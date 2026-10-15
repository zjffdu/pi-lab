# Pi Learning Labs

Small, self-contained projects for learning Pi one runtime concept at a time.

## Where to start

- [Learning path](docs/learning-path.md) — the order of the 22 labs, what each one adds, and the current status of
  every lab (tests, what was and was not verified).
- Each lab's own `README.md` — the question, a scenario, the idea, the measured experiment, and how to run it.
- [Design history](docs/learning-path.md#design-history) — the original per-phase plans, kept as written.

The rules every lab shares are in [Working agreement](#working-agreement) below.

## Labs

### Phase 1 — Pi `Agent` (in memory)

- [Lab 01 — Pi Agent Loop](lab-01-pi-agent-loop/README.md)
- [Lab 02 — Teams Transport, No Agent Yet](lab-02-teams-echo/README.md)
- [Lab 03 — Teams to Pi](lab-03-teams-pi/README.md)
- [Lab 04 — Multi-tool Shipment Investigation](lab-04-multi-tool-investigation/README.md)
- [Lab 05 — Multi-turn In-memory Sessions](lab-05-multi-turn-sessions/README.md)
- [Lab 06 — Failures and Concurrency](lab-06-failures-and-concurrency/README.md)

### Phase 2 — durable runtime (`pi-durable`)

- [Lab 07 — Durable Harness Session](lab-07-durable-harness-session/README.md)
- [Lab 08 — Crash Recovery](lab-08-crash-recovery/README.md)
- [Lab 09 — Tool Replay Safety](lab-09-tool-replay-safety/README.md)
- [Lab 10 — Context Compaction](lab-10-context-compaction/README.md)
- [Lab 11 — Session Tree and Navigation](lab-11-session-tree/README.md)
- [Lab 12 — Durable Entries and Model Context Projection](lab-12-context-projection/README.md)
- [Lab 13 — Tool Governance and Runtime Hooks](lab-13-tool-governance/README.md)
- [Lab 14 — Typed Telemetry and Behavioral Evaluation](lab-14-telemetry-evaluation/README.md)

### Phase 3 — enterprise assistant scenario

- [Lab 15 — Integrated Runtime Contract (`pi-durable`)](lab-15-integrated-runtime/README.md)
- [Lab 16 — Authenticated Principal and Tenant Isolation (`pi-durable`)](lab-16-identity-and-isolation/README.md)
- [Lab 17 — Resource Authorization and Delegated Access (`pi-durable`)](lab-17-resource-authorization/README.md)
- [Lab 18 — Durable Human Approval (`pi-durable`, PostgreSQL)](lab-18-human-approval/README.md)
- [Lab 19 — Untrusted Content and Data Egress (`pi-durable`)](lab-19-untrusted-context/README.md)
- [Lab 20 — Connector Reliability and Execution Budgets (`pi-durable`)](lab-20-connector-reliability/README.md)
- [Lab 21 — Durable External Effects (no Pi, PostgreSQL)](lab-21-durable-effects/README.md)
- [Lab 22 — Observability, Evaluation, and Release Gates (`pi-agent-core`)](lab-22-observability-and-release/README.md)

Every lab is an independent Node.js project with its own dependencies, tests, and a bilingual README
(`README.md` / `README.zh-CN.md`).

## Pi versions

Each lab pins its Pi packages to exact versions and is migrated in place (no parallel copies).

- `pi-agent-core` / `pi-ai` `1.1.0`: Labs 01, 03, 04, 05, 06, and 22 (Lab 22 only for its optional live judge).
- `@earendil-works/pi-durable` `1.1.0` (with `chord` and `pi-ai`): Labs 07–20.
- No Pi dependency: Lab 02 (Teams transport only) and Lab 21 (uses `pg`).

`pi-durable` is marked Experimental by its own README. See [CLAUDE.md](CLAUDE.md) for the per-lab details.

## Prerequisites

| Need | For | Notes |
| --- | --- | --- |
| Node.js `>=24.5.0` and npm | every lab | each lab's `package.json` declares it; run `npm ci` inside the lab |
| A model key (`DEEPSEEK_API_KEY` in the lab's ignored `.env`) | live runs only (`npm run agent`, `npm run dev`) | deterministic tests and scripted demos need no key; copy `.env.example` and fill it in |
| `podman` or `docker`, then `npm run db:up` | Labs 18 and 21 | starts a lab-owned PostgreSQL 16 container and writes `DATABASE_URL` to the ignored `.env`; without it Lab 21's database tests are skipped and its `npm run check` fails |
| Microsoft 365 Agents Playground | Labs 02 and 03 | local Teams-style client; no Teams tenant is needed |

## Check everything

```bash
scripts/verify-labs.sh                       # every lab's own `npm run check`, one at a time
scripts/verify-labs.sh lab-13-tool-governance lab-15-integrated-runtime   # selected labs
```

The script only orchestrates: it never installs dependencies, never edits a lab, and reports a lab without
`node_modules` as `SKIP`. Labs 18 and 21 need their database running first (see above).

## What is in a lab directory

- `README.md` / `README.zh-CN.md` — the question, a scenario, the idea, the measured experiment, how to run it,
  self-test questions. Labs 15–22 also record their evidence status here.
- `WORKSHEET.md` (Labs 15–22) — a blank learner worksheet: prediction, observation, explanation, transfer.
  A prediction the learner skipped is recorded as `waived`.
- `REFERENCE.md` (Labs 15–18) — the reference explanation, kept apart so it is not read before the prediction.
- `RUNBOOK.md` (Labs 21–22) — operational steps (manual repair, release and rollback).
- `SOURCES.sha256` (Labs 21–22) — hashes of the sources the lab's evidence was produced from.
- `runtime-evidence/`, `session-data/` — ignored run output; never hand-edited or committed.

## Working agreement

This is the single copy of the rules every lab shares.

### Repository contract

- One self-contained project per lab at the repository root; no intermediate `labs/` directory. Each lab has its
  own `package.json`, lockfile, source, tests, fixtures, README, and ignored runtime-data directory.
- Completed labs stay runnable. Do not turn them into shared packages or silently upgrade their dependencies. A
  later lab may copy verified code, recording its source; there are no cross-lab runtime imports. The root script
  above may orchestrate lab checks without sharing their implementation.
- Work on one active lab at a time. Do not scaffold or implement a later lab unless explicitly asked.
- Every experiment starts with the learner's written prediction. Do not reveal the expected answer before it is
  recorded; an explicit request to skip it is recorded as `waived`.
- Keep deterministic type checks and tests free of live model calls and live Teams or enterprise calls. Live smoke
  tests are a separate, explicitly bounded step.
- Pin SDK versions exactly and revalidate the SDK's behavior when a lab starts.
- Keep secrets only in each lab's ignored `.env`; commit only `.env.example` with empty values. Never put
  credentials or raw authorization headers in logs, manifests, fixtures, or reports.
- Keep sessions, business state, traces, and evaluation artifacts local; use synthetic fixtures. PostgreSQL is
  local and lab-owned (Labs 18 and 21 only).
- Treat JSONL session, attempt, and outbox files as evidence of one run, not fixtures.
- Commit only when explicitly asked.

### Standard learning loop

1. Read the core question, scope, exclusions, and acceptance criteria.
2. Record a prediction (or `waived`) before seeing the result.
3. Implement the smallest path that exposes the concept.
4. Run the deterministic type check and tests.
5. Run one bounded live-model or real-service check, only where the concept needs one.
6. Run the lab's defined failure, restart, or contrast experiment.
7. Inspect the trace, durable entries, state, or audit, not only the final answer.
8. Explain the observation in your own words; Phase 3 adds a transfer question on a changed scenario.
9. Record commands, evidence, and unresolved uncertainty in the lab README.

A directory's presence is not evidence of completion: a lab is complete only when its acceptance criteria have
current evidence recorded in that lab. For process-crash experiments, a parent test waits for a named checkpoint
before killing the child; it never relies on timing or arbitrary sleeps.

### Starting or resuming a lab

1. Read the [learning path](docs/learning-path.md), this README, and the lab's own documents.
2. Inspect `git status` and preserve unrelated work.
3. Verify the previous lab's recorded evidence; do not infer completion from its directory.
4. Revalidate the exact pinned SDK version and the APIs the lab needs.
5. Restate the lab's core question, scope, exclusions, prediction gate, failure injections, and verification plan.
6. Stop for the learner's prediction unless it has been waived.
7. Implement only the active lab, then record the evidence actually obtained.

Suggested opening request:

```text
Read docs/learning-path.md and the active lab documents. We are starting Lab NN.
Do not implement later labs. First restate the scope, prediction gate,
and verification plan, then guide me through the lab.
```
