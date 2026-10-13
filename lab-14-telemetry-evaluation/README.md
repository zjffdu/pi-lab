# Lab 14 — Typed Telemetry and Behavioral Evaluation

English | [中文](README.zh-CN.md)

**Question:** how do you know a Pi agent is reliable, without just reading one final answer?
**Answer this lab shows:** you check the evidence the run left behind, in two separate lanes:

- **Deterministic checks.** Did it look the booking up? Did every identifier it names come from a tool result? Did the
  status change happen exactly once? These are yes/no questions about the transcript and the spans, not about how
  the answer sounds.
- **A semantic score.** Is the answer clear and helpful? This needs a judge, so it is one separate, bounded model call
  that never overrides a check.

Think of an inspection: the checklist ("was the seal intact?") and the inspector's overall impression are different
things, and you never let a good impression tick a failed box.

## A concrete scenario

You run a booking assistant and want to switch to a cheaper model. Someone asks it *"Which containers are on booking
`BK1001`?"* and it answers: *"BK1001 has container MSKU1234567."* It reads fine. A reviewer approves it.

But `BK1001` has **two** containers, and the new model never called `get_booking` — it answered from memory.

- **Reading the answer** shows nothing wrong. It is fluent, and the one container it names is real.
- **The checks** show two things at once: `required-tool-evidence` fails (no lookup in the transcript, no `lab.tool`
  span), and `container-coverage` fails (`MSKU2345678` is missing). A semantic judge, which sees only the request and the answer, has no way to notice either.
- **Running it twice** matters too. Same case, same prompt: one run can be grounded and the next can add "(format is
  like BK1001)" — a real booking number the model never looked up. `identifier-provenance` fails that one.

Who needs to understand this? **You, the developer who decides whether a model or prompt change is safe.** Users
never see any of it; the lab teaches you what to record and what to check so the decision rests on evidence.

| In the scenario | In the lab |
| --- | --- |
| "did it really look it up?" | `required-tool-evidence`, read from the durable transcript |
| "is every container it names real?" | `identifier-provenance` (booking and container numbers) |
| "did it name all of them?" | `container-coverage` |
| "did the status change happen once?" | `duplicate-effects` |
| the shape of one run | `lab.*` spans built from the event stream |
| "was it clear and helpful?" | `semantic-judge.ts`, kept apart from every check |

## The idea

Pi records a run as committed events. This lab turns one conversation's event stream into spans, and grades the run:

```text
one case, one fresh fixture, one fresh storage
  ├─ events (watchEvents) ──► lab.run > lab.turn > { lab.ai.request, lab.tool }   (the spans)
  ├─ durable entries      ──► tool calls, arguments, results, the answer          (the evidence)
  └─ both                 ──► checks: pass | fail | skipped | unavailable
                          └► one isolated judge call → a score, never a verdict
```

Three things to take away:

1. **A check has four outcomes, not two.** `skipped` means it does not apply; `unavailable` means the data does not
   exist (navigation and recovery are never visible in the stream; latency is unavailable unless every request
   carries a `durationMs`). Folding `unavailable` into pass or fail is the mistake to avoid.
2. **Spans nest by position, and a run is only readable after two waits.** Events carry no run or turn id, so a
   stack models the nesting. After `submission.wait()` you must wait for the terminal `submission` event, stop the
   stream, then flush two microtasks — only then are the spans complete and `settled`.
3. **One good run proves little.** Identical repetitions can differ, so the report is per case and per repetition,
   bound to model, prompt version, and case list.

Not covered: hosted telemetry, exporters, dashboards, a large regression suite. Six cases, two repetitions, one model.

## The experiment

`npm run demo:telemetry-evaluation` runs against a live model:

1. Run six frozen cases × two repetitions, each on a fresh `BookingRepository` and storage. `BK1001` has two
   containers (`MSKU1234567`, `MSKU2345678`), `BK1002` one, `BK1003` one and `delivered`.
2. Grade each run, print its trace, and print one run's span tree.
3. Take real captured evidence and break it three ways — remove the lookup, double the status change, remove the run
   span — to show each check catches exactly that.
4. Ask one isolated judge call to score one answer.

## What we measured

One live run, `deepseek/deepseek-flash`, `promptVersion=v2`, 12 runs (`pass / fail / skipped / unavailable`):

| check | result | check | result |
| --- | --- | --- | --- |
| `required-tool-evidence` | 8 / 0 / 4 / 0 | `token-usage` | 12 / 0 / 0 / 0 |
| `identifier-provenance` | 12 / 0 / 0 / 0 | `latency` | 12 / 0 / 0 / 0 |
| `container-coverage` | 2 / 0 / 10 / 0 | `span:lab.tool` | 10 / 0 / 0 / 0 (10 runs expected a tool) |
| `duplicate-effects` | 12 / 0 / 0 / 0 | `unobservable:navigation`, `:recovery` | 0 / 0 / 0 / 12 each |

- **All 12 runs reached `done`, every span was `settled`, and the bridge raised no warning.**
- **`latency` passes here** because every assistant message carried a `durationMs` (for example 3634 ms and 1296 ms
  on the `status-change` run). It is the provider's time, not a span duration — spans have no timestamps.
- **Nothing failed in this run, but an earlier run of the same cases did.** In that one, `unknown-booking` repetition 1
  said "format is like BK1001", and `identifier-provenance` failed it while repetition 0 passed. That run's output is not
  kept in the repo, so treat it as an observation, not a measurement; the offline tests below reproduce it on demand.
- **The three injections all fail as designed**, and what the stream cannot show is reported `unavailable`, never `fail`.
- **The judge scored `lookup-single` 5/5.** It is one call on one answer; it says nothing about the other cases.

The offline tests (real `Harness`, scripted model) prove what a live run rarely produces: a fluent answer with no
lookup fails `required-tool-evidence`; a doubled `update_booking_status` fails `duplicate-effects` with two real
executions; a two-container booking described by one container fails `container-coverage` even after a real lookup;
an unlooked-up or invented container fails `identifier-provenance`; an invalid argument or an unknown tool is a
`refused` tool span with no warning. The live run never produced the single-container failure.

## Run it

```bash
cd lab-14-telemetry-evaluation
npm install
cp .env.example .env            # then fill in DEEPSEEK_API_KEY
npm run check                   # typecheck + 121 offline tests, no model calls
npm run demo:telemetry-evaluation
```

Try it by hand:

```bash
npm run agent -- --case status-change --trace --spans             # the trace, then the span tree
npm run agent -- --case list-containers --case compare-two --repetitions 2
ls session-data                                                    # one JSONL storage per run
```

In the trace, `assistant (tool call) … call=<id> args=<json>` is what the model asked for and
`tool_start`/`tool_end` is Pi running it; the `call=` id pairs them. The suffix `(stop=… tokens=… …ms)` on an
assistant line is the same three facts the `lab.ai.request` span carries. The report (every check's detail, every
span, every tool call) is written to `runtime-data/evaluation-report.json`. Do not hand-edit `session-data/`.

## Test yourself

Answer 1–3 before running the demo:

1. Which Pi component opens telemetry spans here? For one tool call plus a final answer, draw the span tree.
2. `submission.wait()` has returned. What two things must happen before `getSpans()` is complete?
3. A fluent answer names only real booking numbers but never called `get_booking`. Which checks fail, which pass?
4. `BK1001` has two containers; the answer names one. Provenance or coverage — which fails, and why not the other?
5. Why is `latency` `unavailable` offline but `pass` live, and why does it refuse to sum a partial set?
6. Why is a judge score never allowed to turn a `fail` into a `pass`?

(No learner prediction has been recorded for this lab.)

## Good to know

- **Pins:** `pi-durable`, `pi-ai`, `chord`, `pi-telemetry` `1.1.0`. Default model `deepseek-flash`. `pi-durable` is
  experimental, so what follows was read from its types and then observed.
- Pi opens no spans of its own: a grep of `pi-durable`, `chord`, and `pi-ai` finds no `startSpan` call. The `lab.*`
  vocabulary is declared in `src/telemetry-schema.ts`, and `pi-telemetry` uses it for types only, not validation.
- A refused call (unknown tool, invalid arguments) arrives as a `tool_execution_end` with no `tool_execution_start`;
  checked with a scripted model, not read from docs.
- A `tool_execution_end` with no entry means the task faulted or was orphaned, and counts as a failure. This comes
  from the type declaration and is covered by a unit test on hand-built events, not by a live fault.
- `containerNos` is a non-empty array. A container is grounded only by a successful tool result **of the same run**.
- Compaction is off. Provider/connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md). A stale
  `PI_MODEL=deepseek-v4-flash` fails at startup with `Unknown model`; set `deepseek-flash`.

## Where things are

```text
src/harness-telemetry.ts       watchEvents -> lab.* spans (open on one event, close on another)
src/telemetry-schema.ts        the lab.* span vocabulary
src/harness-trace-logger.ts    the trace: request line vs execution line, (stop tokens ms) per assistant line
src/settle.ts                  waits for a submission's terminal event (tracer and bridge share it)
src/evidence.ts                tool calls and the answer, read back from the durable entries
src/deterministic-checks.ts    every check, and what is `unavailable`
src/evaluation-cases.ts        the six frozen cases, PROMPT_VERSION
src/evaluation-runner.ts       repetitions x cases, fresh fixture + storage, the settle order
src/semantic-judge.ts          the one isolated judge call
src/span-tree.ts, report.ts, cli.ts, booking-repository.ts, *-tool.ts, create-harness.ts, session-store.ts
scripts/telemetry-evaluation-demo.ts   the live experiment
tests/evaluation-runner.test.ts        the core offline proof, on real Harness runs
```
