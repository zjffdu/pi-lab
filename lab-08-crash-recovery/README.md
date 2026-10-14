# Lab 08 — Crash Recovery

English | [中文](README.zh-CN.md)

**Question:** if the process is killed while a tool call is running, what does Pi do when the session is reopened?
**Answer this lab shows:** it does not lose what was committed, it does not guess the missing result, and it does not
rerun the tool by default. Two separate things make that work:

- **What is already on disk.** The user's message, the model's tool-call request, and the *intent* to run the tool are
  all committed before the tool body starts. A restart can see all of it, and can see which work is unfinished,
  *before* anything runs.
- **What recovery does with the missing result.** The tool's result never existed, so recovery records that fact: a
  failed tool task and an error result saying the call "was interrupted and may have partially run". The model then
  carries on from that fact.

Think of a restaurant order slip: the order is on the slip before the kitchen starts cooking. If the kitchen burns
down mid-dish, the slip survives, and the waiter tells the guest "that dish didn't come out" instead of inventing a plate.

## A concrete scenario

You build a shipment assistant. A customer asks *"What are the movement events for container MSKU1234567?"* The tool
that looks them up is slow, and the server is redeployed while it runs:

| Moment | What happens |
| --- | --- |
| 10:00:00 | The question is committed. The model asks for `get_container_events`; that request is committed too. |
| 10:00:01 | The tool task is committed as pending, then the tool starts. **The process is killed.** |
| 10:05:00 | A new process opens the same session. Before running anything it can list what was left: one unsettled question, one pending tool task, one waiting model request. |
| 10:05:01 | It resumes. The tool is **not** run again. An error result is committed, the model is asked once more, and tells the customer the lookup did not complete. |
| 10:06:00 | Someone asks the system about that question again. It returns the stored answer; nothing runs. |

**Without this**, the customer's question is lost, or the server guesses an answer, or it silently reruns a lookup
that might have had a side effect. **With it**, the outcome is explicit and the audit trail is intact.

Who needs to understand this? **You, the developer**: you decide what to show the customer after a restart, and which
tools are allowed to be rerun (that is Lab 09). The customer only sees "the lookup did not complete".

| In the scenario | In the lab |
| --- | --- |
| the question | a `submission`, status `placed` (accepted, not finished) after the kill |
| the order slip | a `pi.tool` task at `phase=execute` |
| listing what was left | `harness.inspect()` |
| "carry on" | `harness.resume()` + `harness.submission(id).wait()` |
| the stored answer | waiting on an already-settled submission |

## The idea

```text
submit -> user entry, submission(placed)
  model asks for a tool -> assistant entry (tool call)
    pi.tool task committed (intent) -> tool body starts      <- killed here
reopen -> inspect(): [pi.tool pending] [pi.generation waiting] [submission placed]   (nothing has run)
resume -> tool not rerun -> error result entry -> model answers -> submission done
```

1. **Durable is earlier than you think.** At the kill, everything except the tool's result is committed.
2. **`inspect()` is read-only.** A freshly opened harness is `scheduling=paused`; `resume()`, `submit()` and `wait()`
   turn scheduling on. So you can look at the crash site first.
3. **Recovery ends in a settled submission, not a returned value.** `resume()` returns nothing. You wait on the
   submission, and waiting on a settled one just returns its stored record.

Not covered: choosing a replay policy (Lab 09), compaction, forks, random kill timing, providers failing over.

## The experiment

`npm run demo:crash` runs one live scenario with three child processes. The parent never sleeps to guess timing: it
reads the child's stdout and sends `SIGKILL` the instant it sees `[Checkpoint] tool_dispatched`, a line the slow tool
prints when it starts.

1. Child 1 asks the question and is killed at the checkpoint.
2. Child 2 reopens the session, prints what `inspect()` found, then resumes and waits for the submission.
3. Child 3 reopens it again and waits on the same (settled) submission.

## What we measured

From one live run:

| | entries | unfinished tasks | unsettled submissions | tool executions | final answer |
| --- | --- | --- | --- | --- | --- |
| after the kill (child 2, before resume) | 4 | 2 (`pi.tool` pending, `pi.generation` waiting) | 1 (`placed`) | 1, by the killed process | none |
| after resume (child 2) | 6 | 0 | 0 | 1 (not rerun) | "The lookup for container MSKU1234567 did not complete…" |
| after asking again (child 3) | 6 (same newest entry) | 0 | 0 | 1 | the same stored record |

- **Two entries were added by recovery**: the error `pi.tool-result` and the new answer. There is exactly one
  `pi.user` entry, so recovery never re-asked the question.
- **The `[Checkpoint]` line carries the tool's `taskId`**, and `inspect()` reports that same task as unfinished: the
  killed call and the recovered one are the same call.
- **The task record ends `failed`** with "…was interrupted and may have partially run"; `grep -c "was interrupted"
  session-data/<id>/main.jsonl` finds it.
- **Newest entry moved, ids that identify the work did not**: the user entry, the submission and the tasks keep their ids.
- Offline tests reproduce the same crash without killing anything, by copying the session directory at the checkpoint.

Your recorded predictions, checked against this run:

| Prediction | What happened |
| --- | --- |
| "user message is already durable" | True, and more: the tool-call request and the tool task's intent are durable too. Only the result is missing. |
| "recover the state" | `resume()` turns scheduling on; the missing result is recorded as failed, not reconstructed. |
| "tip ID stay stable" | The newest entry moved; the user entry, submission and task ids stayed. |
| "replay the cached result" | For a settled submission, yes: its stored record. `resume()` itself returns nothing. |

## Run it

```bash
cd lab-08-crash-recovery
npm install
cp .env.example .env     # then fill in DEEPSEEK_API_KEY
npm run check            # typecheck + 35 offline tests, no model calls
npm run demo:crash       # the live experiment above
```

Try it by hand (after the demo, with `--session try`):

```bash
npm run demo:crash -- --session try
npm run agent -- --session try --resume --settled        # unfinishedTasks=0, the stored record, entries unchanged
grep -c "was interrupted and may have partially run" session-data/try/main.jsonl   # 1
```

Do not hand-edit `session-data/`.

## Test yourself

Answer 1–3 before running the demo:

1. What is committed at the moment of the kill, and what is not?
2. What will `inspect()` list in a new process before `resume()`, and why can it list it without running anything?
3. Will the tool run again? What will the model be told?
4. Why does asking a third time change nothing?
5. The `[Checkpoint]` line is printed by the tool and watched by the parent. Does it write anything to storage?

## Good to know

- Pins: `pi-durable`, `pi-ai`, `chord` `1.1.0`; default model `deepseek-flash`. `pi-durable` is experimental.
- The checkpoint line is only a signal between two processes. What recovery reads is the task's own saved state.
- After an `interrupted` result the model may ask for the lookup again. That is a *new* call, not a replay; the demo
  only asserts the killed call never runs twice.
- One process per session at a time: `pi-durable` does not lock a storage. Provider problems: see [Lab 01](../lab-01-pi-agent-loop/README.md).

## Where things are

```text
src/slow-container-events-tool.ts   the slow tool; prints the checkpoint with taskId and callId
src/cli.ts                          --prompt, or --resume [--settled]
src/create-harness.ts               registry, Harness.open(), inspect()
src/harness-trace-logger.ts         run/turn tree; spans from before the restart marked ↺
scripts/crash-recovery-demo.ts      the parent: spawn, wait for the checkpoint, SIGKILL, resume, re-read
tests/crash-recovery.test.ts        the same crash offline, from a disk snapshot
```
