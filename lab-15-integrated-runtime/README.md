# Lab 15 — Integrated Runtime Contract

English | [中文](README.zh-CN.md)

**Question:** when governance, audit, telemetry, egress checks and a durable session all run in the same runtime, does
each one's guarantee still hold?
**Answer this lab shows:** only where something *installs* it again. A session stores some things and not others:

- **Stored in the session:** the conversation history, the set of tools offered to the model, and a note's projection.
- **Not stored:** the hooks, the tool code, the egress configuration, the business data behind the tools.

So every guarantee in the second list is only as good as the one function that wires it up (the *composition root*),
and every guarantee in the first list can disagree with what your application wants *today*.

Think of moving house: your furniture (history) comes with you, but the alarm and the door locks (hooks) must be
installed again — and the removal van may still carry the old key rack (the stored tool set).

## A concrete scenario

You run an operations assistant for bookings. `BK1001` has two containers. Ops staff ask it to change a booking's
status; policy forbids cancelling; every decision must be audited; and a case note must never leak its discount code.

1. **Monday.** An employee says *"cancel BK1001"*. The model calls `update_booking_status`. Policy refuses, one audit
   line says `blocked`, nothing changes, and the model tells the employee why. The trace shows `⊘ tool_refused … code=blocked`.
2. **Monday, later.** *"Set BK1001 to in_transit."* One change is recorded — for the **booking**, so for both containers.
3. **Tuesday.** The service restarts and reopens the session. The history is back. But hooks and tool code live in the
   process, not the session, so they must be installed again before the first request.
4. **Wednesday.** A release stops offering the write tool. The session still *stores* the old offer, and Pi keeps it
   unless the application replaces it. If the model asks for the withdrawn tool, the call is refused before any hook runs.
5. **Thursday.** A bug in how a note is written copies the discount code into the model's context. Everything reports
   success — unless an egress check is configured.

**Who has to understand this? You, the developer.** Employees see none of it; a reviewer sees the audit and the result.

| In the scenario | In the lab |
| --- | --- |
| "who decided what, for which request" | the audit record, joined by request / session / conversation / task / call ids |
| "did it actually change anything" | the effect ledger — separate from the answer and from the tool outcome |
| "install it again after a restart" | `openIntegratedRuntime()` (`src/composition.ts`), the composition root |
| "the old offer is still stored" | `ToolSetReconciliation`, via `configure({ tools })` |
| "check the bag before leaving" | three egress layers in `src/egress.ts` |

## The idea

One request returns four facts, kept apart on purpose (`src/run-result.ts`):

| Fact | Where it comes from |
| --- | --- |
| **operation** — completed / failed / rejected | the submission's settled record (`done` / `unanswered`), or a refusal before submitting |
| **answer** | the entry Pi recorded as the answer — never an earlier preamble |
| **tool outcomes** — ok / error / blocked / unavailable / invalid_arguments | the `code` Pi stores on each tool result |
| **business effects** | a ledger written only when a mutation really happened |

`mechanism` (did the machinery hold together?) is judged separately from behavior (was the outcome what we wanted?).
Three extensions are installed: `booking` (the prompt), `booking-governance` (**both tools and the hooks that guard
them**) and `egress-backstop`.

Three things to take away:

1. **Put a tool and its guard in one extension.** A conversation stores extension *names*. Reopen without the
   governance extension and there are no booking tools at all — the call is refused as `tool_unavailable`. A tool
   installed separately from its guard runs ungoverned and unaudited (a test pins this contrast).
2. **Deny by default.** The governance hook sees every tool, including one added later in another extension; a tool
   with no policy entry is blocked and audited.
3. **No hook can stop a provider request**, so egress is three layers: refuse a leaky projection at write time, scan
   the committed context before submitting (zero requests), and a `beforeRequest` backstop that can only *withhold*
   the value — the request is still sent.

Not covered: who the user is or what they may touch (Labs 16–17), approval (18), real external services.

## The experiment

`npm run demo:integrated` is scripted (no network, no live model: a fake provider returns canned answers). It runs five
scenarios against the real `Harness` and a real JSONL session, and prints for each request the trace, the result, the
audit lines, what the provider received, and the spans. Every trace line is prefixed with the request id.

| Scenario | Provider requests | What happened |
| --- | --- | --- |
| 1. allowed write on `BK1001` | 3 | one effect covering both containers; audit `allowed` + `executed`; mechanism ok |
| 2. cancel `BK1001` | 2 | no effect; audit `blocked`; trace `⊘ tool_refused code=blocked`; span says `refused` |
| 3. reopen, app now offers read-only | 2 | stored offer was both tools → reconciled to one; write call is `unavailable`, no audit line |
| 4a. leaky note, no egress config | 1 | the secret **reached the provider**; everything still says success |
| 4b. same, preflight + backstop | **0** | request refused before submitting |
| 4c. same, backstop only | 1 | the provider got a withheld marker; `mechanism` **fails** (an upstream layer let it through) |
| 5. a reused request id | 1 in total | the second prompt was **not run**; result marked `deduplicated` |

- **The audit says why, the span and the trace say only that it was refused.** A blocked call and a policy *exception*
  both end as `blocked`; only the audit (a decision vs. none) tells them apart, and `mechanism` fails for the exception.
- **A failed run is not a run without effects.** In a test, a write followed by a provider error is `failed` with no
  answer and one effect.
- **Pi uses the request id as an idempotency key**, durably: the reused id returns the original answer even after a restart.

`npm run evidence` binds each roadmap criterion to the tests that pin it (a renamed test makes it `unmapped` and fails
the run) and writes `runtime-evidence/{manifest,experiments,acceptance}.json`:

| | Criterion | Status |
| --- | --- | --- |
| AC1 | a request is followable through runtime, policy, tool, audit, outcome | verified |
| AC2 | a blocked call creates no business effect | verified |
| AC3 | provider failure gives a failed run, not a success or a preamble | verified |
| AC4 | reopening reinstalls governance before any tool runs | **partial** |
| AC5 | a prohibited payload causes zero provider requests | **partial** |
| AC6 | removing a required governance component fails a contract test | verified |
| AC7 | missing SDK correlation fields are mapped; ids not interchangeable | verified |

- **AC4 is partial:** a crash mid-run followed by a resume was not exercised, and a registry assembled outside the
  composition root that installs its own ungoverned tool is not protected.
- **AC5 is partial:** zero requests holds for what is committed plus the prompt when you submit. Content that first
  appears *during* the run — a tool result, or the system prompt and tool declarations — is withheld, not prevented.

## Run it

```bash
cd lab-15-integrated-runtime
npm ci
npm run check                # typecheck + 90 offline tests, no model calls
npm run demo:integrated      # the scripted walk-through above
npm run evidence             # acceptance + manifest; exits 1 on any failure
../scripts/verify-labs.sh    # from the repo root: every lab's own check
```

Try it by hand:

```bash
npm run demo:integrated | grep tool_refused        # the two refused calls: code=blocked and code=tool_unavailable
npm run demo:integrated | grep "provider saw"      # true, false, false for scenario 4
npx vitest run -t "blocks a tool that has no policy entry"
npx vitest run tests/egress.test.ts                # 16 tests
cat runtime-evidence/acceptance.json               # after `npm run evidence`
```

## Test yourself

Answer 1–3 before running the demo:

1. A policy-blocked write: how many audit lines, how many business effects, and which trace line marks it?
2. After a restart, what must the application install again, and what does the session give back on its own?
3. The session stored both tools; this release offers only the read tool. What does the provider's next request declare,
   and what happens if the model calls the write tool anyway?
4. Why does a tool *outside* the governance extension still get blocked, and what is the reason in the audit line?
5. Why can the backstop not return "zero requests", and what does it do instead?
6. A request id is reused with a different prompt. Which prompt runs, and how does the result tell you?

## Good to know

- **Pins:** `pi-durable`, `chord`, `pi-ai`, `pi-telemetry` `1.1.0`. `pi-durable` is experimental. There is no live-model entry
  point; the default model id is only checked against the catalog in a test.
- **Status:** the learner prediction was waived and the worksheet transfer questions (T1–T3) are unanswered. No live-model
  run and no independent review were done; the source baseline is uncommitted, so the manifest records `dirty`.
- **Scripted, not live:** event order, token counts and failure shapes come from a fake provider. Only the `model_error`
  failure was tried; rate limits and timeouts were not.
- **Limits of the guard:** it matches the exact text, not a paraphrase; the request-to-entry join assumes one request in
  flight per conversation. A hook cannot read its request from Pi, so the application binds it.
- **Not carried in:** session forking (Lab 11) and Lab 14's evaluation cases are not part of this composition.
- Answers to the worksheet are in `REFERENCE.md` — attempt T1–T3 first.

## Where things are

```text
src/composition.ts           the composition root: request(), appendCaseNote(), close()
src/create-harness.ts        the registry (three extensions), openHarness, tool-set reconciliation
src/governance-hooks.ts      both tools + beforeTool/afterTool; deny-by-default policy table
src/run-result.ts            the four facts, verifyMechanism, evaluateBehavior
src/correlation.ts, audit-log.ts, effect-ledger.ts   who supplies which id; audit lines; effects
src/egress.ts                write-time check, preflight, withholding backstop
src/harness-trace-logger.ts  run/turn tree: request-id tag, ⊘ tool_refused, codes
src/harness-telemetry.ts     event stream → lab.* spans (from Lab 14)
scripts/integrated-demo.ts, evidence.ts, acceptance-map.ts
tests/                       11 files; scripted-runtime.ts builds the real harness over a fake provider
```
