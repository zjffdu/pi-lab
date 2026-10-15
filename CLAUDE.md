# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A sequence of small, independent, self-contained TypeScript/Node.js labs for learning the Pi agent SDK
(`@earendil-works/pi-agent-core` / `@earendil-works/pi-ai`) one runtime concept at a time — from the bare
agent loop, through Teams transport, multi-tool reasoning, multi-turn sessions, and failure/concurrency
handling (Phase 1, labs 01–06), to a durable `pi-durable` runtime with crash recovery, tool-replay
safety, context compaction, session trees, and context projection (Phase 2, labs 07–14), then to an
enterprise-assistant reference scenario (Phase 3, labs 15–22). Pi 1.1 migrations are done in place, so
a lab's directory name never carries a version suffix (see the pin rule below for which labs are on which
version).

Each `lab-NN-*/` directory at the repo root is its own Node.js project with its own `package.json`,
lockfile, `src/`, `tests/`, fixtures, and `README.md`. There is no shared runtime package between labs —
limited duplication across labs is intentional so each lab stays independently inspectable.

## Read before working in a lab

1. Root [README.md](README.md) — lists all labs, their prerequisites, and the **Working agreement** (repository
   contract, learning loop, how to start or resume a lab). That section is the single copy of the shared rules.
2. [docs/learning-path.md](docs/learning-path.md) — the order of the labs, what each adds, the `0.85.1` →
   `pi-durable` 1.1 terminology table, and the status of every lab. The original per-phase plans (core question,
   scope, exclusions, prediction gate, failure injections, acceptance criteria) are design history in
   [docs/design/](docs/design/): written before the labs were built, not maintained, and not authoritative for
   what the code does. Use them as the starting point when adding a new lab.
3. The active lab's own `README.md`, and for labs 15–22 its `WORKSHEET.md` (blank learner worksheet),
   `REFERENCE.md` (reference explanation — do not read before the learner's prediction is recorded or waived),
   and `RUNBOOK.md` where present.

## Repository-wide rules

The full repository contract is the root README's Working agreement. The ones to keep in mind while editing:

- Do not turn earlier labs into a shared package, silently upgrade their dependencies, or otherwise modify a lab
  you were not asked to work on. Work on one active lab at a time; do not scaffold a later lab unless asked.
- Every experiment starts with a written prediction from the learner — do not reveal the expected answer before it
  is recorded (or waived).
- Keep deterministic type-checks/tests free of live model calls or Teams calls; live smoke tests are a
  separate, explicitly-bounded step (`npm run agent -- "..."`, `npm run dev` + Playground, `npm run demo:*`).
- Secrets live only in each lab's ignored `.env`; commit only `.env.example` with empty values.
- JSONL session/attempt/outbox files under a lab's gitignored runtime-data directory (e.g. `session-data/`,
  `runtime-evidence/`) are evidence of one learner's run, not fixtures — never hand-edit or commit them.
- Commit only when the user explicitly asks.

## Pinned versions per lab

Pi SDK versions are pinned per lab with exact versions, and a lab is migrated in place (no parallel `-pi-1.1`
copy). Revalidate the SDK against the pinned version before starting a lab rather than assuming behavior carries
over, and see "Pi 1.1 standard" below before writing or porting anything to `1.1.x`.

- Labs 01 and 03–06: `pi-agent-core` / `pi-ai` `1.1.0`.
- Lab 02: no Pi dependency.
- Labs 07–14: `@earendil-works/pi-durable` `1.1.0` (rewritten, with `chord` and `pi-ai`; none depends on
  `pi-agent-core`). Lab 14 also pins `@earendil-works/pi-telemetry` `1.1.0`.
- Lab 15: `pi-durable` `1.1.0` (with `chord`, `pi-ai`, and `pi-telemetry`; no `pi-agent-core`). It composes the
  Lab 12–14 pieces, and because no 1.1 seam can stop a provider request its egress layers are a write-time check,
  a pre-flight scan, and a `beforeRequest` backstop that *withholds* rather than blocks.
- Lab 16: `pi-durable` `1.1.0` (with `chord`, `pi-ai`, and `jose`; no `pi-agent-core`). The in-run `beforeRequest`
  boundary only records, so its blocking check is a pre-flight scan before `submit()`.
- Lab 17: `pi-durable` `1.1.0` (with `chord`, `pi-ai`, and `jose`; no `pi-agent-core`). It replaces the stored tool
  offer with `configure({ tools })` on every operation, before any `submit()` or `resume()`.
- Lab 18: `pi-durable` `1.1.0` (with `chord`, `pi-ai`, `jose`, and `pg`; no `pi-agent-core`). The propose tool is
  closed over each request's `SecurityContext` in a registry rebuilt per request, because a conversation stores
  only tool names and `root({ agent })` applies only at creation. Two requests on one session, each with its own
  `openNodeJsonlStorage` handle and its own `Harness`, gave two user messages the same entry id and forked the
  history while both requests still answered 200, and a storage reads its entries when it is opened, so
  `ChatService` queues requests per session and opens the storage *inside* the queue; `pi-durable` does not
  document this.
- Lab 19: `pi-durable` `1.1.0` (with `chord`, `pi-ai`, `jose`, and `dotenv`; no `pi-agent-core`). No hook can
  *stop* a provider request, so its egress layers are a pre-`submit()` preflight, a write-time gate inside the
  document tools, and a `beforeRequest` backstop that *withholds*. A summarization request does not pass through
  `beforeRequest`, but `beforeCompact` runs for manual, threshold, and overflow compaction and can `decline`,
  which is the summarizer's only gate. A compaction summary is a *user-role* message on a `pi.compaction` entry,
  so derivation is decided by entry kind, not message role. Revoking a role is enforced by the request's registry
  alone, so only a *grant* shows whether `configure({ tools })` re-applied the offer.
- Lab 20: `pi-durable` `1.1.0` (with `chord`, `pi-ai`, and `jose`; no `pi-agent-core`). No 1.1 hook can end a run,
  so its turn and context limits call `root.abort()` from `afterTools` / `beforeRequest`, which *races* the next
  request and has been seen to lose with JSONL storage, hence `beforeRequest` also replaces an over-limit
  request's messages with a placeholder and the guarantee is what the request carries, not whether it is sent.
  Cancellation is `root.abort()`, never a cancelled `Context` given to `wait()`, which stops only the wait. A
  tool's `context.abortSignal` also fires after `execute()` returns, so a listener flag proves nothing. There is
  no `maxTokens` setting, so the output cap is a Proxy over the provider's `getModels()`;
  `settings.stream.maxRetries` is pinned to 0 so only `settings.retry` retries model calls. The stored tool offer
  is replaced with `configure({ tools })` on every request and read back; requests are queued per session; a
  session with unsettled submissions is refused.
- Lab 21: no Pi dependency (it uses `pg`).
- Lab 22: `pi-agent-core` / `pi-ai` `1.1.0` (only its optional live judge uses Pi; its lockfile is Lab 01's with
  the two `name` fields changed, proven with `npm ci` in a clean copy).

## Pi 1.1 standard

Applies to any lab pinned to `@earendil-works/pi-agent-core` / `pi-ai` `1.1.x`; no lab is on `0.85.1` any more, so
the `0.85.1` comparisons below are historical. Derived by diffing the two versions' type declarations
and running scripted probes against both, not from a changelog (the packages ship none).

- Pin `pi-agent-core` and `pi-ai` to the same exact version (`1.1.0`) and regenerate the lockfile from
  scratch (`rm -rf node_modules package-lock.json && npm install`). Then prove it with `npm ci` in a clean
  copy: an incremental install once produced a lockfile whose nested `vitest/node_modules/@esbuild/*`
  entries lacked `optional: true`, which makes `npm ci` fail with `EBADPLATFORM` on any non-matching CPU
  while `npm install` and `npm run check` still pass. A from-scratch install can reproduce this (the Lab 04
  port did, via `vite 8.3.4` pulling in an `esbuild 0.28.2`); when the new lab's dependency set is identical
  to an already-proven 1.1 lab, copy that lab's lockfile and change only its two `name` fields, then re-prove with `npm ci`.
- DeepSeek default model id is `deepseek-flash`. The `0.85.1` id `deepseek-v4-flash` does not exist in the
  `1.1.0` catalog, so a stale `PI_MODEL` fails at CLI startup with `Unknown model`; neither tsc nor tests
  catch this unless a test resolves the default id through `builtinModels()` (see
  `tests/create-agent.test.ts` in the 1.1 lab).
- The system prompt and tool declarations are a leading `system` message in the transcript:
  `agent.state.messages` starts `system, user, assistant, …`, a `StreamFn` receives a `TranscriptContext`
  with only `messages`, and `agent.state.systemPrompt` is read-only. That message emits no `message_*`
  event, so trace loggers never show it. Tool declarations travel as `toolsAdded` / `toolsRemoved` on system messages and a request has no
  `tools` field, so a test reading `context.tools` gets `undefined` and every "tool X was not offered" assertion passes vacuously; fold the system
  messages instead (Lab 17's `offeredToolsOf`), with a positive control. In `0.85.1` the transcript started at `user` and `systemPrompt` /
  `tools` were separate context fields.
- The event order (`agent_start` → `turn_start` → `message_*` → `tool_execution_*` → `turn_end` →
  `agent_end`) and the failure path (`stopReason: "error"` plus `agent.state.errorMessage`, which the CLI
  turns into a non-zero exit) are unchanged from `0.85.1`.
- Tool-call `arguments` are typed `JsonObject`, not an arbitrary record; test fixtures must use pi-ai's
  `JsonObject`.
- Per the type declarations (not exercised by any lab yet): `shouldStopAfterTurn` became `finishTurn`
  (returns `{ action: "continue" | "end" }`), `prepareRequest` is new, and tools can return `isError`,
  `structuredContent`, and an `outputSchema`.
- `AgentHarness`, `Session`/JSONL session repos, lanes, and compaction are no longer exported by `pi-agent-core`
  `1.x`: the harness subpaths exist through `0.99.2` and are gone in `1.0.0`, and none of the other `1.1.0`
  packages searched exports them. Phase 2 labs therefore cannot be moved to `1.1.x` by bumping the pin.
  The `1.1.0` package that presents itself as the durable agent harness is `@earendil-works/pi-durable`; its README
  marks it **Experimental** ("API changes without notice"), and it is a redesign, not a rename: `Harness.open(storage)` + `root()` Conversation replace `AgentHarness` + `lane`,
  entry `kind` is an open string (`pi.user`, `pi.assistant`, …), ids are numbers from one shared counter, there is
  no branch tip (`head` marks where model context starts; `fork(at)` makes a separate conversation), and
  `root({ agent })` applies only at creation. Labs 07, 08, 09, 10, 11, 12, 13, and 14 are rebuilt on it (Lab 12: `entryProjectors` and `toProviderMessages` have no equivalent, an entry's contribution to context is its own `model` field, so a custom entry is `defineEntry` with `data` and no `model` (durable-only) or `data` plus a `model` produced by a pure projection function **at write time** and stored, `Conversation.context()` returns `entries`/`contributions`/`messages` as the observer, a later entry's `edits` takes a projection back out without touching storage, and the provider boundary is `hook(GenerationTask, { beforeRequest })`, which sees the final `Message[]` of every request attempt and can only check, since a throw there is reported through `onReport` and the request is still sent; Lab 13: `activeToolNames` becomes the conversation's stored tool offer, `root({ agent: { tools } })` at creation and `configure({ tools })` afterwards, and `before_tool`/`after_tool` become `hook(ToolTask, { beforeTool, afterTool })` inside an extension, which has no handler ids, so the extension name is the identity; `beforeTool` runs after the tool resolves and its arguments validate and before the intent commit, and a throw becomes a block; `afterTool` runs between `execute()` and the result entry, and a throw is swallowed (fail-open) by the one `hooks.each` try/catch that reports to `HarnessOptions.onReport`, whose default is a no-op; a refused call (`tool_unavailable`, `invalid_arguments`, `blocked`) still commits an error `pi.tool-result` carrying a diagnostic `code` but emits `tool_execution_end` with no `tool_execution_start`; hooks see `api.taskId`, `api.conversationId`, and `call.id`, with no run, lane, or turn id; Lab 11: going back to an earlier entry and changing the premise is `conversation.fork(entryId)`, a second
  Conversation in the same storage; `navigateTree()`, the tip pointer, `BranchSummaryEntry`, and entry labels have no equivalent, labels are an app-level `defineDoc`,
  and a fork's inherited entries keep the parent's `conversationId`; Lab 10: compaction is a task + a write submission and the cut is observed
  through `head`; `lane.compact()` and `retainedTail` have no equivalent. Lab 08: `lane.resume()`/`open[]` become
  `harness.inspect()` + `harness.resume()` + `harness.submission(id).wait()`; see below); Lab 14:
  Pi 1.1 ships no telemetry schema — `HARNESS_TELEMETRY_SCHEMA`, `startHarnessSpan`, and `withTelemetryContext` left with the old harness, and no 1.1 package
  (`pi-durable`, `chord`, `pi-ai`, `pi-agent-core`) calls `startSpan` — so Pi opens zero spans of its own; only `@earendil-works/pi-telemetry` remains
  (`InMemoryTelemetryContext`, `defineTelemetrySchema`, `createTypedSpanStarter`; `memory.js` is byte-identical to 0.85.1 and spans still carry no timestamps,
  and a span is `settled` one microtask after its callback promise resolves). The lab declares its own `lab.*` schema and bridges `watchEvents` into it; the
  stream is serialized per conversation, so nesting is positional (events carry no run or turn id), there is no `recovery` flag, and `fork()` emits no event; a refused call (unknown tool, invalid arguments) is a `tool_execution_end` with no
  `tool_execution_start`, which the bridge records as an `outcome="refused"` span rather than treating as an anomaly.
  `AssistantMessage` now carries `provider`/`model`/`api`/`usage`/`stopReason`/`durationMs`, so a provider-request span is built from `message_end` alone and
  latency is the message's own `durationMs`, never a span duration; the terminal `submission` event (after `run_end`) is what means "every event of this run was
  consumed"). Pin `pi-durable`, `pi-ai`, and `chord` to the same exact version.
  Crash recovery (Lab 08, verified by a real `SIGKILL` and an offline snapshot test): a tool call is a `pi.tool` task whose
  intent is committed before `execute()` runs, and `execute(args, api, context)` exposes `api.taskId` / `api.callId`. After a kill,
  `inspect()` (read-only; scheduling is `paused` until `resume()`/`submit()`/`wait()`) reports that task `pending` at `phase=execute`
  plus its waiting `pi.generation`, and the `placed` submission. A tool is `replay: "unsafe"` by default, so recovery does not rerun it:
  the task settles `failed` ("interrupted and may have partially run") and an `isError` `pi.tool-result` is committed; declaring
  `replay: "safe"` reruns it (Lab 09: the rerun keeps the same `taskId` and `callId`, commits one real result, and emits no
  `tool_execution_start` in the recovering process; `tool.js` reruns only when the policy stored in the intent checkpoint **and** the
  installed tool both say `safe`, and both directions are pinned by tests; the stored policy shows in `inspect()` as `replay=` on the tool task's checkpoint but not as plaintext in the JSONL; a state-changing tool
  wrongly declared `safe` is rerun and duplicates its effect, because `replay` is the author's promise that Pi does not check). `resume()` returns `void` and is idempotent; there is no `NothingToResume` —
  waiting on an already-settled submission returns its stored record. `scanSubmissions` is on `Storage`, not `Harness`.
- Test the real `Agent`, not only hand-built events: the Phase 1 agent factory (`createBookingAgent`, or
  `createSessionAgent` in Lab 05) accepts an optional scripted `streamFn` (built with
  `createAssistantMessageEventStream`), which is how the 1.1 labs assert the actual trace tree, transcript
  roles, tool-error propagation, provider-failure recording, and (Lab 05) which messages each conversation's
  model call receives, offline.
- Session management is not part of `pi-agent-core` `1.1.0`. Its exports are only `Agent`, `agent-loop`,
  `proxy`, `stream-fn`, and types; `Agent.sessionId` is just a string forwarded to the provider for caching.
  Mapping a conversation identity to a transcript is therefore application code (Lab 05's
  `src/session-registry.ts`, a `Map<conversationId, Agent>`). `pi-durable` does have conversations
  (`Harness.open(storage)`, `createConversation()`, `fork()`, SQLite/JSONL storage, `resume()`), but identifies
  them by its own ids; it exposes no lookup by an external conversation id, so a real service still keeps
  that mapping itself (inferred from the `pi-durable` README, not exercised by a lab).

## Lab README style

Written for a learner who is reading to understand, not to audit. Lab 12's README is the reference. Keep it short
(about 150 lines for the English one) and make sure a learner who ran the lab and read the README can state the lab's
takeaway in their own words.

- **Open with the question and the answer.** One line each. Then explain any two-part answer in plain words, and add
  a one-line everyday analogy if it helps.
- **Then a concrete scenario, before any technical concept.** A realistic product situation (a person, a booking, a
  secret that must not leak), told as a timeline: what goes wrong without the lab's approach, what the lab does, what
  the user sees. End it with a table mapping each thing in the scenario to a concept or file in the lab. Say who has to
  understand the concept: usually the developer, not the end user.
- **Then the idea, in at most a screenful.** One table or one diagram, and three takeaways. No exhaustive vocabulary
  section and no API reference; link to the types or source instead.
- **Then the experiment and what was measured.** A short list of the steps, one results table from a real run, and a
  few bullets saying what each number means. Do not paste whole console output.
- **Every claim in it is backed by something you ran.** If a behavior comes from a type declaration and was not tested,
  say so in one line. Do not describe what was removed or changed from an earlier Pi version in the lab's own README.
- **End with:** how to run it (`npm run check` and the demo), a few commands to try by hand (run them and check the
  output matches before writing them down), self-test questions (answer the first few before running the demo), a short
  "good to know" list, and a file map of a few lines.
- **Bilingual:** `README.md` and `README.zh-CN.md` carry the same content and link to each other, and both are updated
  in the same change. Code, identifiers, and commands stay in English.
- Only synthetic fixture tokens may appear in a README; never a real key or credential.

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
  reconstruction. An assistant message's text and each tool call it requests are separate lines
  (`assistant (tool call) <name> call=<id> args=<json>`), so the model's request is distinguishable from Pi's
  `tool_start`/`tool_end` execution of it (the `call=` id pairs them). This is the primary tool for explaining
  *why* a given turn happened.
- `src/cli.ts` — entrypoint; converts `agent.state.errorMessage` into a non-zero exit code instead of
  treating an empty/failed response as success.
- Lab 05 adds `src/session-registry.ts` (reuse one in-memory `Agent` per conversation id, isolate other ids,
  lose everything on restart) and a conversation-tagged `session-trace-logger.ts`.
- Booking fixtures: a booking can have several containers. Labs 01, 04, 05, 07, 08, 09, 10, 11, 12, 13, 15, 16, 17, 18, 19, and 22 model this as a non-empty
  `containerNos: string[]` validated in `isBooking`; Lab 20 serves it from its booking API as a validated non-empty, unique `containerNos` and counts a listing complete only when its container identities equal that set; Labs 03 and 06 still use a single `containerNo`.

### Phase 2 labs (07–14): durable runtime on `pi-durable` `1.1.0`

Swaps the ephemeral `Agent` for a durable `Harness` and `root()` conversation persisted through JSONL storage
(`openNodeJsonlStorage`), so runs survive process restarts and can be inspected/replayed after a crash. The
original plan's `AgentHarness` / `lane` / `Session` vocabulary maps to this API in the
[terminology table](docs/learning-path.md#terminology-the-original-plan-vs-pi-durable-11). Common additional files:

- `src/create-harness.ts` — harness construction (replaces `create-agent.ts`).
- `src/session-store.ts` — the durable session backing store; writes land in a lab-local gitignored
  directory (e.g. `session-data/`) treated as run evidence, not source.
- `src/harness-trace-logger.ts` — the harness-event equivalent of the Phase 1 trace logger; later labs
  extend it with recovery-specific markers (e.g. a `↺` replay marker in lab-09) that earlier Phase 2 labs
  don't need.
- `src/checkpoint.ts` (Labs 08–09) and `scripts/*-demo.ts` — lab-specific mechanics for the concept under test
  (crash recovery, tool replay safety, compaction, session tree navigation, context projection).

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
