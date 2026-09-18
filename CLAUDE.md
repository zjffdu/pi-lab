# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A sequence of small, independent, self-contained TypeScript/Node.js labs for learning the Pi agent SDK
(`@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`) one runtime concept at a time — from the bare
agent loop, through Teams transport, multi-tool reasoning, multi-turn sessions, and failure/concurrency
handling (Phase 1, labs 01–06), to a durable `AgentHarness` runtime with crash recovery, tool-replay
safety, context compaction, session trees, and context projection (Phase 2, labs 07–14).

Each `lab-NN-*/` directory at the repo root is its own Node.js project with its own `package.json`,
lockfile, `src/`, `tests/`, fixtures, and `README.md`. There is no shared runtime package between labs —
limited duplication across labs is intentional so each lab stays independently inspectable.

## Read before working in a lab

1. Root [README.md](README.md) — lists all labs and links to the two roadmaps.
2. [ROADMAP.md](ROADMAP.md) (Phase 1, labs 01–06) or [ROADMAP-PHASE-2.md](ROADMAP-PHASE-2.md) (Phase 2,
   labs 07–14) — the canonical source for each lab's core question, scope, explicit exclusions, prediction
   gate, failure injections, and completion criteria.
3. The active lab's own `README.md` (and an `ARCHITECTURE.md` if one exists in that lab — most don't).

## Repository-wide rules (from the roadmaps' "Repository contract" sections)

- One self-contained project per lab at the repo root; no intermediate `labs/` directory.
- Do not turn earlier labs into a shared package, silently upgrade their dependencies, or otherwise
  modify a lab you were not asked to work on.
- Work on one active lab at a time. Do not scaffold or implement a later lab unless explicitly asked.
- Every experiment starts with a written prediction from the learner (turn count, event ordering, failure
  behavior, etc.) — do not reveal the expected answer before that prediction is recorded.
- Keep deterministic type-checks/tests free of live model calls or Teams calls; live smoke tests are a
  separate, explicitly-bounded step (`npm run agent -- "..."`, `npm run dev` + Playground, `npm run demo:*`).
- Secrets live only in each lab's ignored `.env`; commit only `.env.example` with empty values.
- JSONL session/attempt/outbox files under a lab's gitignored runtime-data directory (e.g. `session-data/`,
  `runtime-evidence/`) are evidence of one learner's run, not fixtures — never hand-edit or commit them.
- Pi SDK versions are pinned per lab (currently `0.85.1` across all labs); revalidate current SDK docs
  before starting a new lab rather than assuming behavior carries over.
- Commit only when the user explicitly asks.

## Commands

All commands run from inside a specific `lab-NN-*/` directory — `cd` there first.

```bash
npm install                          # once per lab
npm run check                        # typecheck + full test suite (the standard gate)
npm run typecheck                    # tsc --noEmit
npm test                             # vitest run (all tests, no watch)
npm run test:watch                   # vitest watch mode
npx vitest run tests/some-file.test.ts   # run a single test file
npx vitest run -t "test name substring"  # run tests matching a name
```

Live/interactive commands, present when the lab defines them:

```bash
npm run agent -- "What are the details for booking BK1001?"   # Pi-only labs: one-shot CLI prompt
npm run dev                          # Teams labs (02, 03): start the local server on :3978
npm run playground                   # Teams labs: launch Microsoft 365 Agents Playground against it
npm run demo:<name>                  # Phase 2 labs: a scripted scenario in scripts/*.ts
                                      # (e.g. demo:crash, demo:replay, demo:session-tree)
```

All Pi-backed labs launch Node with `--use-env-proxy` so the model provider client honors
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`.

## Architecture

### Phase 1 labs (01–06): in-memory `Agent`

Built directly on `@earendil-works/pi-agent-core`'s `Agent`. The loop is: user prompt → LLM turn →
optional tool call(s) → tool result appended to context → next LLM turn (automatic, no new user
message) → repeat until the model stops requesting tools. Common per-lab files:

- `src/create-agent.ts` — model selection (`PI_PROVIDER`/`PI_MODEL` env vars), system prompt, `Agent`
  construction, tool wiring.
- `src/*-repository.ts` — deterministic, runtime-validated access to a local JSON fixture under `data/`
  (never `as Type` casts on untrusted fixture data).
- `src/*-tool.ts` — one `AgentTool` per file: TypeBox `parameters` schema + `execute()`; a thrown error
  becomes a tool-error result fed back to the model, not a thrown exception in the loop.
- `src/trace-logger.ts` — subscribes to the agent's `AgentEvent` stream and renders it as an indented
  `▶`/`◀` agent/turn/tool tree instead of one flat line per event, so nesting is visible without mental
  reconstruction. This is the primary tool for explaining *why* a given turn happened.
- `src/cli.ts` — entrypoint; converts `agent.state.errorMessage` into a non-zero exit code instead of
  treating an empty/failed response as success.

### Phase 2 labs (07–14): durable `AgentHarness`

Swaps the ephemeral `Agent` for `AgentHarness` plus a `Session` persisted through a JSONL-backed repo, so
runs survive process restarts and can be inspected/replayed after a crash. Common additional files:

- `src/create-harness.ts` — harness construction (replaces `create-agent.ts`).
- `src/session-store.ts` — the durable session backing store; writes land in a lab-local gitignored
  directory (e.g. `session-data/`) treated as run evidence, not source.
- `src/harness-trace-logger.ts` — the harness-event equivalent of the Phase 1 trace logger; later labs
  extend it with recovery-specific markers (e.g. a `↺` replay marker in lab-09) that earlier Phase 2 labs
  don't need.
- `src/checkpoint.ts`, `scripts/*-demo.ts` — lab-specific mechanics for the concept under test (crash
  recovery, tool replay safety, compaction, session tree navigation, context projection).

### Teams transport labs (02, 03)

Keep Teams strictly as a thin transport adapter around the Pi runtime, never the runtime itself:

- `src/create-app.ts` / `src/index.ts` — `@microsoft/teams.apps` server setup, started against the
  Microsoft 365 Agents Playground for local testing (never real Teams tenant deployment in these labs).
- `src/message-handler.ts` + `src/agent-runner.ts` (lab-03) — the boundary that extracts text from a
  Teams message, delegates to a fresh Pi `Agent` per request, and returns the final answer; this boundary
  is unit-tested with a fake agent runner, keeping live model calls out of deterministic tests.
- Separate trace loggers for each side of the boundary (`teams-trace-logger.ts` vs `pi-trace-logger.ts`),
  correlated by one request ID, so Teams-transport events and Pi-runtime events stay distinguishable in
  the log.
