# Lab 07 — Durable Harness Session

English | [中文](README.zh-CN.md)

**Question:** after a process restart, how does a conversation that already finished a turn pick up where it left off?
**Answer this lab shows:** the conversation lives in files, not in the process. Two things follow:

- **The files hold the conversation.** Every message and tool result is committed to a JSONL storage directory. A new
  process opens the same directory and reads the same entries back.
- **The process holds only the machinery.** The `Harness` (model calls, tools, scheduler) is built fresh on every start.
  Nothing in it needs to survive.

Think of a notebook and a pen: the notebook is the storage, the pen is the harness. Replace the pen and the notes are still there.

## A concrete scenario

You build a support assistant. A customer asks about booking `BK1001`, then, ten minutes later, *"Which container is it
using?"* In between, your service was redeployed.

| Moment | Without durable storage | With this lab's approach |
| --- | --- | --- |
| Customer asks about `BK1001` | the assistant looks the booking up and answers | the same, and every message and the tool result is committed to disk |
| Redeploy | the process dies and the transcript dies with it | the process dies, the files stay |
| Customer asks "Which container is it using?" | a new process knows nothing and must ask "which booking?" | a new process opens the same session, reads the transcript, and names both containers without looking the booking up again |
| A different customer asks the same follow-up | n/a | their session is a different directory, so the assistant asks which booking they mean |

Who needs to understand this? **You, the developer.** Customers never see sessions. You decide what a session id maps to
(a chat, a user, a ticket) and make sure the same id reaches the same storage after a restart.

| In the scenario | In the lab |
| --- | --- |
| the customer's chat | a session id (`conversation-a`) |
| the notebook | the storage directory `session-data/<id>/` |
| the pen | the `Harness`, opened by `Harness.open(storage)` |
| the thread of the chat | the root `Conversation` and its `Entry` records |
| one customer message and its answer | one `Submission` (`submit()` then `wait()`) |
| "the old process left nothing half-done" | `harness.inspect()` reporting no unfinished tasks |

## The idea

```text
session id ─▶ storage directory ─▶ Harness.open() ─▶ root() ─▶ submit() / wait() ─▶ close
                  (on disk, kept)      (rebuilt each start)
```

| Thing | Lives in | After a restart |
| --- | --- | --- |
| entries, documents, tasks, submissions | the storage files | read back as they were |
| `Harness`, `Conversation` handle | process memory | created again |
| tools and system-prompt text | your code (an extension registry) | you install them again |

Three things to take away:

1. **A completed transcript survives a clean restart, and the follow-up is answered from it.** No second tool call is made.
2. **Different session ids never meet.** Each id is its own directory and starts empty.
3. **"Nothing left unfinished" is a weaker claim than "unfinished work is recoverable."** `inspect()` is empty here
   because every run finished. Killing a process mid-run is not covered; it is the next lab's job.

Not covered: a crash mid-run, tool replay, compaction, forks, and any Teams transport.

## The experiment

Each CLI call is one turn in one process, so running it again is a real restart. Fixture: [`data/bookings.json`](data/bookings.json);
`BK1001` has two containers.

1. Turn 1, new session `conversation-a`: "What are the details for booking BK1001?" (a real tool call).
2. Turn 2, new process, same session id: "Which container is it using?"
3. Contrast, new session `conversation-b`: the same follow-up.

## What we measured

From one live run on `deepseek/deepseek-flash`:

| invocation | session | `entries(before)` | tool call | `entries(after)` | answer |
| --- | --- | --- | --- | --- | --- |
| turn 1 | `conversation-a` created | 0 | `get_booking` | 5 | lists both containers |
| turn 2 (new process) | `conversation-a` reopened | 5 | none | 7 | "uses two containers", both named |
| contrast | `conversation-b` created | 0 | none | 3 | asks which booking is meant |

- **`newestEntry(before)` of turn 2 equals `newestEntry(after)` of turn 1** (both `15`): the newest entry was read from files an
  exited process wrote. The count alone would not show that.
- **Turn 2 adds exactly two entries** (a `pi.user`, a `pi.assistant`; ids `16` and `19`). The five from turn 1 are untouched.
- **Entry ids skip numbers** (`7, 10, 11, 13, 15, 16, 19`): entries, tasks, documents, and submissions draw from one counter. Count
  the `[Entry]` lines, not the ids. The `seq` on each line of `main.jsonl` is a different number, the commit's position.
- **`conversation-b` has a `pi.system` entry and turn 2 of `conversation-a` has none**: the system entry holds the prompt and tool
  declarations and is written only when they change.
- **The second container, `MSKU7654321`, is on disk in the tool result (turn 1) and in each answer that names it**, which is why turn 2
  needs no lookup.

The offline tests assert the same on a scripted model: the reopened transcript equals the first process's entries record for
record; the second request carries the first process's tool result; `get_booking` ran once across both processes; `inspect()` is
empty on every attach; a provider failure settles `unanswered` and the CLI exits 1.

## Run it

```bash
cd lab-07-durable-harness-session
npm install
cp .env.example .env            # then fill in DEEPSEEK_API_KEY
npm run check                   # typecheck + 25 offline tests, no model calls
```

Try it by hand (each line is its own process):

```bash
npm run agent -- --session try --prompt "What are the details for booking BK1001?"
npm run agent -- --session try --prompt "Which container is it using?"
npm run agent -- --session other --prompt "Which container is it using?"
ls session-data/try                       # main.jsonl plus doc-N.jsonl files
grep -c MSKU7654321 session-data/try/main.jsonl   # 3: the tool result and the two answers
```

Reading the trace: it is the same run/turn tree as the earlier labs, built from committed events. The model's tool-call request
(`assistant (tool call) … call=<id> args=<json>`) and Pi running it (`tool_start`/`tool_end`) are separate lines paired by `call=`.
`[Harness] unfinishedTasks=… unsettledSubmissions=…` is `inspect()` at startup. Do not hand-edit `session-data/`.

## Test yourself

Before running, write down your answers to 1–3; the rest after:

1. After a restart, which entries are still there?
2. What is rebuilt on restart, and what is read back from disk?
3. What does the second process call to get "the same conversation", and what identifies it?
4. Why does turn 2 need no `get_booking` call, and which line of the trace shows it?
5. What does `unfinishedTasks=0` prove here, and what does it not prove?
6. Why does `conversation-b`'s first turn add a `pi.system` entry and turn 2 of `conversation-a` does not?

(No learner prediction has been recorded for this lab.)

## Good to know

- **Pins:** `pi-durable`, `pi-ai`, `chord` `1.1.0`. `pi-durable` is marked experimental, so what this lab relies on was read from its
  types and then observed. Default model `deepseek-flash`.
- `root({ agent })` applies only when the conversation is created. Reopening with another `PI_MODEL` keeps the stored model.
- The extension code is never stored. A conversation follows whichever extensions the process installed, so every process that
  reopens a session installs them again. Not tested here: a process that forgets to.
- One process owns a storage at a time; there is no cross-process lock. A service that serves many sessions must route one session
  to one process, and decide how long to keep a `Harness` open. This lab opens and closes it per call.
- A provider error such as a bad key is not retried: the submission settles `unanswered` with `reason: "model_error"`.
- `WatchHandle.stop()` does not promise to flush pending events, so the trace waits for the submission's terminal event first, and
  writes a warning line instead of hanging if it never comes.
- Provider/connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md). A stale `PI_MODEL` fails at startup with
  `Unknown model`; use `deepseek-flash`.

## Where things are

```text
src/session-store.ts          session id -> storage directory; created or reopened
src/create-harness.ts         model choice, extension registry, Harness.open() + root()
src/get-booking-tool.ts       the tool, defined with defineTool()
src/harness-trace-logger.ts   watchEvents() rendered as a run/turn/tool tree
src/transcript.ts             all entries of a conversation, oldest first
src/booking-repository.ts, cli.ts
data/bookings.json            BK1001 with two containers
tests/durable-harness-session.test.ts   the core offline proof (close, reopen, follow-up, isolation)
```
