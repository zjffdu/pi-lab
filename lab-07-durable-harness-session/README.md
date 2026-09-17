# Lab 07 — Durable AgentHarness Session

Give a Pi conversation a body that outlives the process. This lab swaps Lab 05's plain
`Map<conversationId, Agent>` (gone the instant the process exits) for a JSONL-backed
`Session`, an `AgentHarness` attached to it, and one `main` lane — and shows exactly what
does and does not come back after a clean restart.

## Learning objective

By the end of this lab, you can explain this from your own console output and JSONL files:

```text
conversation id
  -> open or create local JSONL Session
  -> AgentHarness
  -> lane("main")
  -> prompt and completed operation
  -> close process

same session id after restart
  -> reopen JSONL Session
  -> recreate AgentHarness
  -> lane("main")
  -> follow-up sees the durable transcript
```

This lab builds on [Lab 05](../lab-05-multi-turn-sessions/README.md)'s two-turn scenario and
reuses its `get_booking` fixture. It does **not** cover killing the process mid-operation
(that is [Lab 08](../ROADMAP-PHASE-2.md)), tool replay policy (Lab 09), compaction (Lab 10),
tree navigation (Lab 11), or any real Teams transport — this lab stays a terminal CLI so
transport concerns never obscure the persistence boundary being taught here.

## Vocabulary (read before predicting)

- **Session** — the durable JSONL store for one conversation's entries. Owns nothing about
  what is "currently running"; it is a plain, append-only, restartable log.
- **Entry** — one durable record in a session: a message, a compaction summary, a branch
  summary, or a custom record. Each has a stable `id`, a `parentId` (the entry it was
  appended after), and a `seq` (write order).
- **Branch tip** — the id of the most recent entry on a named branch (this lab only uses
  `"main"`). It is nothing more exotic than a pointer to the latest entry — the durable
  equivalent of a Git branch's `HEAD`. Two sessions have two completely separate tips;
  reopening a session does not move its tip, only reads it.
- **AgentHarness** — the runtime object you attach to one open `Session` to drive turns
  against it. It owns model/tool configuration and dispatches to one or more lanes; it is
  not itself durable state — it is rebuilt fresh from the session every time a process
  starts.
- **Lane** — one durable, named execution line within a session (this lab only uses
  `"main"`). A lane is *not* the same thing as the session: the session is the storage: a
  lane is a live handle, acquired from a harness, that reads and appends to one branch of
  that storage and tracks whether an operation is currently running on it.

## Prerequisites

- Node.js 24.5 or newer
- npm
- Credentials for a model provider supported by `@earendil-works/pi-ai`

The default configuration uses DeepSeek V4 Flash through the official DeepSeek API, same as
every earlier lab.

## API note (revalidated against the pinned version)

This lab pins `@earendil-works/pi-agent-core@0.85.1`, matching the roadmap baseline — but
that package's own `README.md` does not document `AgentHarness`, `JsonlSessionRepo`, or the
lane API at all. Everything this lab calls was reverse-engineered from the package's shipped
`.d.ts` declarations and compiled source under `node_modules/@earendil-works/pi-agent-core/dist/harness/`,
not from prose documentation. If you revisit this lab against a newer Pi version, re-read
those declaration files before assuming any signature below still holds:

- `JsonlSessionRepo` (`harness/session/jsonl/repo.ts`) needs `{ fileSystem, sessionsRoot }`.
  `fileSystem` can be a `NodeExecutionEnv` (imported from `@earendil-works/pi-agent-core/node`,
  a separate subpath export) — it implements the required `FileSystem` interface.
- Sessions are grouped on disk by a `(cwd, id)` pair, not by `id` alone. `cwd` does not have
  to be the OS directory the CLI happens to run from — `JsonlSessionRepo` resolves whatever
  string you pass to an absolute path via its own `fileSystem.absolutePath()` and uses
  *that* as the grouping key. This lab fixes it to one constant (`SESSION_GROUP` in
  `src/cli.ts`) so a session id resolves consistently no matter which shell directory
  `npm run agent` is invoked from — at the cost of a verbose, doubly-nested directory name
  under `session-data/` (see section 5), since the constant gets resolved relative to
  `sessionsRoot` itself rather than to a real project path.
- `AgentHarness.create({ session, models, model, tools, systemPrompt }, context)` returns
  `{ harness, open }`. `open` lists every lane whose last operation was never driven to a
  terminal result — this lab's scope never leaves one, so it must always come back `[]`
  here (a non-empty `open` here would mean the previous process crashed mid-turn, which is
  Lab 08's subject).
- `harness.lane("main", context)` creates the lane on first call and restores it (tip,
  configuration) on every later call in the same or a different process — there is no
  separate "create a lane" step.
- `lane.prompt(text, images, context)` returns a `Result<OperationResultRecord | SuspendedRun, ...>`.
  Unwrap `.ok` before trusting `.value`; a `SuspendedRun` (`status: "suspended"`) means the
  provider deferred its response — not expected from this lab's synchronous tool.

## 1. Predict before running

Record your predictions in writing before installing dependencies or reading further.
This lab's recorded prediction (verbatim, from the person doing this lab):

> 1. 已完成的消息和 tool 结果都会存活 *(all completed messages and tool results survive)*
> 2. 不清楚 *(unclear — is a lane the same thing as a session?)*
> 3. 不明白 branch tip 是什么 *(doesn't yet know what a branch tip is)*
> 4. 不能 *(a different session cannot see conversation-a's history)*

If you are running this lab yourself, write your own answers to the same four questions
before continuing:

1. Which completed messages and tool results survive a process restart?
2. Is a lane the same thing as a session? What is the difference?
3. How does the branch tip change across the two turns in the live scenario below?
4. What can a different session (a fresh conversation id) observe from the first one?

Do not skip ahead to section 5 before writing something down, even a guess.

## 2. Install dependencies

```bash
cd lab-07-durable-harness-session
npm install
cp .env.example .env   # then fill in DEEPSEEK_API_KEY
```

## 3. Verify the deterministic parts

```bash
npm run check
```

This covers the booking repository and harness tool (adapted from Lab 05, note the
different `AgentHarnessTool.execute` signature), `modelSelectionFromEnvironment`, and —
the core of this lab's evidence — `tests/durable-harness-session.test.ts`, which drives the
full `Session -> AgentHarness -> lane` stack deterministically:

- It appends one durable entry with `lane.appendMessage()` (the same durable write a
  completed LLM turn produces) **without calling any model provider**.
- It closes the harness (and session), reopens the same session id from disk, reattaches a
  brand-new `AgentHarness`, and re-acquires `lane("main")`.
- It asserts the branch tip, the entry, and its `parentId` chain all survived untouched,
  that reopening did not duplicate the first entry, that continuing appends onto the
  restored tip, and that `AgentHarness.create()` reports no dangling open operation.
- A separate test proves a different session id starts with a `null` tip and zero entries
  even though the first session already has some — cross-session isolation, with no live
  model involved.

`tests/session-store.test.ts` covers the same create/reopen/isolate story one layer lower,
at the plain `JsonlSessionRepo` level, using `Session.setName()`/`getName()` as a minimal
durable round-trip probe instead of entries.

None of this touches the network. The live scenario below is the only part that does.

## 4. Run the live two-turn scenario

Unlike Lab 05, "restart" here is not a contrived extra step — it is simply running the CLI
again. Each invocation is exactly one turn and one process:

```bash
# Turn 1 — new process, new session
npm run agent -- --session conversation-a --prompt "What are the details for booking BK1001?"

# Turn 2 — a *different* process, same session id: a genuine restart between turns
npm run agent -- --session conversation-a --prompt "Which container is it using?"

# Contrast — a brand-new session id asked the identical follow-up
npm run agent -- --session conversation-b --prompt "Which container is it using?"
```

Actual output from one recorded run (trimmed; entry ids, operation ids, and timestamps are
unique per run — the shape and the `created`/`reopened`/`fromTip`/`tip` values are what to
compare against your own run):

```text
$ npm run agent -- --session conversation-a --prompt "What are the details for booking BK1001?"
[Session] id=conversation-a created path=/.../session-data/--...--/2026-09-17T06-46-11-162Z_conversation-a.jsonl
[Harness] lane=main openOperationsOnAttach=0
[Lane] tipId(before)=null
[User][conversation-a] What are the details for booking BK1001?
[Harness][conversation-a] lane=main tool_start tool=get_booking call=call_00_QA1mKyTFtUO3epzpH54C8296 args={"bookingNo":"BK1001"}
[Harness][conversation-a] lane=main tool_end tool=get_booking call=call_00_QA1mKyTFtUO3epzpH54C8296 status=success
[Assistant][conversation-a] Here are the details for booking BK1001:
- **Container No.:** MSKU1234567
...
[Harness][conversation-a] lane=main run_end run=01a0ae1d-9be2-... status=completed fromTip=null tip=01a0ae1d-9eee-...a419a745e27d
[Operation] operationId=01a0ae1d-9be2-... kind=run status=completed fromTip=null tip=01a0ae1d-9eee-...a419a745e27d ...
[Lane] tipId(after)=01a0ae1d-9eee-...a419a745e27d
[Lane] entries=4
[Entry] seq=4   id=...a40c3dfd5b5c parent=null           type=message role=user
[Entry] seq=28  id=...a410a9242e78 parent=...a40c3dfd5b5c type=message role=assistant
[Entry] seq=38  id=...a415e1dd4c87 parent=...a410a9242e78 type=message role=toolResult toolCallId=call_00_QA1mKyTFtUO3epzpH54C8296
[Entry] seq=124 id=...a419a745e27d parent=...a415e1dd4c87 type=message role=assistant

$ npm run agent -- --session conversation-a --prompt "Which container is it using?"
[Session] id=conversation-a reopened path=/.../same/2026-09-17T06-46-11-162Z_conversation-a.jsonl
[Harness] lane=main openOperationsOnAttach=0
[Lane] tipId(before)=01a0ae1d-9eee-...a419a745e27d
[User][conversation-a] Which container is it using?
[Assistant][conversation-a] Booking BK1001 uses container **MSKU1234567**.
[Lane] tipId(after)=01a0ae1d-df61-...a0ed8b540f1f
[Lane] entries=6
```

Notice: `reopened`, not `created`; `[Lane] tipId(before)` on turn 2 is character-for-character
the same id as `[Lane] tipId(after)` from turn 1 — read from a JSONL file written by a
*different, already-exited process*; and the model answers **without calling `get_booking`
again**, purely from the entries that other process wrote. The `entries=` count jumps from
`4` to `6`, not further — turn 2 added exactly one user entry and one assistant entry, no
duplicates of turn 1's four.

Finally, `conversation-b`:

```text
$ npm run agent -- --session conversation-b --prompt "Which container is it using?"
[Session] id=conversation-b created path=/.../2026-09-17T06-46-34-759Z_conversation-b.jsonl
[Lane] tipId(before)=null
[Assistant][conversation-b] I don't have a booking established yet in this session, so I
can't say which container is in use. Could you tell me the booking number you're asking about?
[Lane] entries=2
```

`created`, a `null` tip before the turn, and no memory of BK1001 — the contrast case, live,
not simulated.

## 5. Inspect the JSONL evidence directly

```bash
find session-data -name '*.jsonl' | sort
cat session-data/**/*conversation-a*.jsonl
```

Read the raw lines. The first line is a header (`{"v":4,"kind":"header","id":"conversation-a",...}`);
every following line is a JSON *array* of one commit's writes — an entry write and, often,
several accompanying value writes (branch tip, lane config, lane state, operation metadata)
committed in the same transaction. Confirm by eye — not just from the CLI's own summary —
that:

- The header's `id` matches `conversation-a`, and its `cwd` is an absolute path resolved
  from this lab's `SESSION_GROUP` constant — not the shell directory you happened to run
  `npm run agent` from.
- Every message entry from turn 1 is still present after turn 2 ran in a new process.
- No entry from turn 1 is duplicated.
- `conversation-a` and `conversation-b` are two entirely separate files.
- Entry `seq` numbers are **not** contiguous (`4, 28, 38, 124, ...` in the recorded run
  above) and do not start at `0` or `1`. `seq` is the commit's position in one shared
  sequence across *every* write to the session — entries and non-entry value writes
  (`pi.branch.tip`, `pi.lane.config`, `pi.op.meta`, `pi.op.state`, and more) all draw from
  the same counter. Do not read `seq` as an entry count or a turn count.

Do not hand-edit these files. If you need to reset a session for a fresh run, delete
`session-data/` and start over — it is ignored by Git and treated as regenerable evidence,
not source.

## 6. Explain the trace

Answer using your own terminal output and JSONL files:

1. Which single field in the CLI's `[Session]` line tells you whether this run recovered an
   existing session or started a new one? Where does that fact ultimately come from —
   process memory, or the filesystem?
2. Is `AgentHarness` durable state, or is it rebuilt every time? What in the code (not the
   JSONL file) proves your answer?
3. What was `openOperationsOnAttach` on every invocation in this lab, and why does the
   roadmap say it must be? What would make it non-empty (you don't need to produce that
   case — that's Lab 08)?
4. Compare `tipId(after)` from turn 1 to `tipId(before)` on turn 2. What does that equality
   prove that reading the JSONL file's entry *count* alone would not?
5. Was your original prediction about "lane vs. session" and "branch tip" right? Write the
   corrected explanation in your own words now that you have evidence.

## Completion criteria

- `npm run check` passes: booking repository, harness tool, `modelSelectionFromEnvironment`,
  the `JsonlSessionRepo` lifecycle tests, and the full `Session -> AgentHarness -> lane`
  durability test.
- A completed transcript (turn 1) survives a clean process restart and is visible to turn 2
  without re-calling `get_booking`.
- Reopening a session never duplicates a user, assistant, or tool-result entry — verified
  both by the deterministic test and by inspecting the raw JSONL file.
- A different session id (`conversation-b`) starts with a `null` tip and zero entries, and
  cannot answer the follow-up without asking which booking is meant.
- `AgentHarness.create()` reports `open: []` on every reattachment in this lab — evidence
  that a *completed* transcript is not the same claim as "in-flight work is recoverable"
  (that stronger claim is Lab 08's, not this lab's).
- You can state, from evidence rather than guessing, the difference between conversation
  identity (the session id string), session identity (the JSONL file), lane identity (the
  named execution line within it), and operation identity (one `lane.prompt()` call's
  result record).

## Project map

```text
src/booking-repository.ts     Lab 05's fixture repository (own copy)
src/get-booking-tool.ts       Harness-flavored tool — different execute() signature from
                               the plain Agent tool used in Labs 01/04/05/06
src/session-store.ts          JsonlSessionRepo wiring + create-or-reopen-by-id helper
src/create-harness.ts         Model selection + AgentHarness.create() + lane("main")
src/harness-trace-logger.ts   harness.events.on(...) lifecycle logging, one call per event type
src/cli.ts                    One CLI invocation = one turn against one named session
data/bookings.json            Same fixture as Lab 05
session-data/                 Durable JSONL sessions this lab writes (git-ignored, local evidence)
tests/                        Deterministic tests — no network calls anywhere
```

## Troubleshooting

See [Lab 01](../lab-01-pi-agent-loop/README.md) for model/provider connection issues — they
apply unchanged here, including the `--use-env-proxy` requirement baked into `npm run agent`.

If `npm run agent` reports `Session is already open`, a previous invocation's process is
still alive (or crashed without releasing its handle) — Lab 07's scope assumes clean exits;
Lab 08 is where an unclean exit becomes the subject of study.
