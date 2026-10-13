# Lab 13 — Tool Governance and Runtime Hooks

English | [中文](README.zh-CN.md)

**Question:** how can the application constrain and audit a model-requested tool call independently of the prompt?
**Answer this lab shows:** with two separate gates that never read the prompt:

- **A gate on what is offered.** A tool the conversation does not offer is not declared to the model, and a call to it
  is refused before any hook runs.
- **A gate on each call.** For an offered tool, a `beforeTool` hook reads the call's structured arguments and the
  current booking state, then lets it run or blocks it, and writes an audit record either way.

Think of it as choosing which tools are on the counter at all, plus a clerk who checks every request against a
rulebook and never listens to how politely you asked.

## A concrete scenario

You build a booking assistant for customer-service staff. It can look up bookings and, to save ops a click, change a
booking's status. Rollout, as a timeline:

1. **Read-only first.** The session offers only `get_booking`. A customer writes *"Cancel BK1002, I'm furious."* The
   assistant says it has no tool for that. Nothing changed, and no audit record exists, because no hook ran.
2. **Ops turn the tool on** for the session. The same message now makes the model ask for
   `update_booking_status(BK1002, "cancelled")`. The `beforeTool` rule sees `newStatus === "cancelled"` and blocks it.
   The model reads *"Tool call blocked: Cancellation is not permitted…"* and tells the customer. The booking is
   unchanged and one audit record says `blocked`. How furious the customer was never reached the rule.
3. *"Mark BK1003 in transit."* BK1003 (two containers) is already `delivered`. A second rule reads that from the
   booking itself, not from the request, and blocks it.
4. *"Mark BK1001 in transit."* This is allowed: a `before_tool allowed` record, the status changes, an
   `after_tool executed` record.
5. **Then the audit disk fails.** If it fails *before* a change, the change is refused: a decision that cannot be
   recorded does not happen. If it fails *after*, the change stands and its execution record is missing; only a
   `[Report]` line shows it.

**Without this lab's approach**, the usual answer is a line in the system prompt: "never cancel bookings."

Who needs to understand this? **You, the developer.** Ops see only that some changes are rejected with a reason;
customers see an apology. The lab shows where the rules go and what each failure leaves behind.

| In the scenario | In the lab |
| --- | --- |
| which tools are on the counter | the conversation's stored tool offer (`configure({ tools })`) |
| the clerk's rulebook | `evaluateUpdateBookingStatusPolicy` in `src/tool-policy.ts` |
| the clerk, at the moment of each request | the `beforeTool` hook in `src/governance-hooks.ts` |
| the ledger | `AuditLog` → `runtime-data/audit-log.jsonl` |
| "the tool and its clerk are hired together" | one extension holds `update_booking_status` and both hooks |

## The idea

```text
model asks for a tool call
  → is the tool offered?          no → refused: tool_unavailable          (no hook, no audit record)
  → are the arguments valid?      no → refused: invalid_arguments         (no hook, no audit record)
  → beforeTool: policy + audit    no → refused: blocked                   (audit: blocked)
  → durable intent → execute()
  → afterTool: audit                                                       (audit: executed / errored)
  → durable pi.tool-result
```

Every ending below is pinned by `tests/governance-pipeline.test.ts` against a real harness and a scripted model:

| Situation | Result `code` | Audit records | Effect |
| --- | --- | --- | --- |
| tool not offered | `tool_unavailable` | none | none |
| impossible argument (`newStatus: "teleported"`) | `invalid_arguments` | none | none |
| policy says no | `blocked` | `before_tool blocked` | none |
| policy hook throws | `blocked` | none | none |
| audit write fails in `beforeTool` | `blocked` | none | none |
| allowed | ok | `allowed` + `executed` | yes |
| allowed, `execute()` throws (unknown booking) | `tool_error` | `allowed` + `errored` | none |
| audit write fails in `afterTool` | ok | `allowed` only | yes |

Three things to take away:

1. **Two gates, and the result `code` tells them apart.** Both "not offered" and "blocked" end as `status=error`.
   Only the second leaves an audit record, because only the second reached a hook. Naming a tool in the system prompt
   (this lab's does, in every scenario) does not make it callable.
2. **`beforeTool` is the only complete audit surface, and it is not first.** It never sees a tool that is not offered
   or arguments that fail validation, and `afterTool` never sees a blocked call. Those refusals are visible only in
   the transcript. The decision is audited in `beforeTool`.
3. **The same audit failure is fail-closed in one hook and fail-open in the other.** The harness runs every hook in
   one try/catch that reports to `onReport`; `beforeTool` adds a second catch that turns a throw into a block, and
   `afterTool` has none, so the executed result stands. This lab only chose not to wrap the audit write in
   `beforeTool`. The risk left over is a real change with no `after_tool` record, and it is silent unless you pass
   `onReport` (the default does nothing; this lab prints it).

Not covered: identity/RBAC/delegated tokens, a general policy engine, real shipment updates (the only effect is an
in-memory change to a fixture).

## The experiment

A booking has `containerNos`, a non-empty list, and one status for the whole booking. Fixture:
[`data/bookings.json`](data/bookings.json): `BK1001` (two containers), `BK1002` (one), `BK1003` (two, already
`delivered`).

`npm run demo:tool-governance` runs five scenarios against a live model, each a fresh session and a fresh repository:

1. `disabled`: the tool is not offered. Ask to cancel `BK1002`.
2. `enabled-normal`: offered. Three turns: cancel `BK1002`, change delivered `BK1003`, move `BK1001` to `in_transit`.
3. `policy-bug`: the `beforeTool` hook throws before doing anything.
4. `audit-sink-fails-before-tool`: every audit write throws; ask for an allowed change.
5. `audit-sink-fails-after-tool`: only the `afterTool` write throws.

## What we measured

From one live run on `deepseek-flash`. The assertions check backend state (the repository, the audit records, each
tool result's `code`, `onReport`), never what the model said:

| scenario | audit records | bookings changed | governed-tool results | `onReport` |
| --- | --- | --- | --- | --- |
| disabled | 0 | 0 | none (model never called it) | 0 |
| enabled-normal | 4 | 1 | blocked, blocked, ok | 0 |
| policy-bug | 0 | 0 | blocked | 0 |
| audit-sink-fails-before-tool | 0 | 0 | blocked | 0 |
| audit-sink-fails-after-tool | 1 | 1 | ok | 1 |

- **`enabled-normal`'s four records** are two `blocked`, one `allowed`, one `executed`. The two blocks cite different
  rules (cancellation; already delivered).
- **`policy-bug` leaves zero records** because the hook threw before it audited: being fail-closed does not depend on
  auditing working.
- **The last row is the gap.** `BK1002` really is `in_transit`, a `before_tool` record exists, no `after_tool` record
  does, and the one `[Report]` line is the only trace of the failure.
- **Audit ids.** A record carries `sessionId`, `conversationId`, `taskId` (the `pi.tool` task), and `toolCallId`; a hook
  is given no run, lane, or turn id, and the record invents none. A test joins `toolCallId` back to the requesting
  `pi.assistant` entry (the turn), the `pi.tool-result` entry, and the submission whose `[entry, answer]` range holds
  the turn (the run).

## Run it

```bash
cd lab-13-tool-governance
npm install
cp .env.example .env            # then fill in DEEPSEEK_API_KEY
npm run check                   # typecheck + 60 offline tests, no model calls
npm run demo:tool-governance    # the live experiment above
```

Try it by hand (turn the tool on in the **first** invocation of a session, because what a session offers is stored):

```bash
npm run agent -- --session try --enable-governed-tool --prompt "Please cancel booking BK1002."
npm run agent -- --session try --inspect    # …pi.tool-result update_booking_status status=error code=blocked
npm run agent -- --inspect-audit            # one before_tool/blocked record: session, conversation, task, call
npm run agent -- --session try2 --enable-governed-tool --simulate-policy-bug --prompt "Mark BK1002 as in_transit."
npm run agent -- --session try3 --prompt "Mark BK1002 as in_transit."   # offeredTools=["get_booking"]
```

In the trace, the model's request (`assistant (tool call) … call=<id>`) and what the harness did about it are separate
lines paired by `call=`. A call that never started prints as `⊘ tool_refused … code=<code>`, with no `tool_start`; one
that ran has `▶ tool_start` … `◀ tool_end`. Do not hand-edit `session-data/` or `runtime-data/`.

## Test yourself

Answer 1–3 before running the demo:

1. A tool is not offered but the model asks for it anyway. Does `beforeTool` run? What does the result say?
2. Does `beforeTool` run before or after the arguments are validated? What does an impossible `newStatus` leave in the audit log?
3. A call is blocked. Is anything durable? Does `afterTool` run?
4. The policy hook throws. Is the tool run?
5. The audit write fails in `beforeTool`, then in `afterTool`. What happens to the change each time, and which one can you see?
6. Why can the policy not be fooled by a customer's wording, and what could still go wrong that the policy cannot see?

(Recorded learner predictions for 1–4, made before any code existed: wrong, wrong, wrong, right.)

## Good to know

- **Pins:** `pi-durable`, `pi-ai`, `chord` `1.1.0` (`pi-durable` is experimental). Default model `deepseek-flash`.
- **The tool and its guard are one extension.** A conversation stores extension *names*, and a name whose code is not
  installed silently stops contributing; hooks have no ids. A test removes the extension and the tool goes with it.
- **What a session offers is durable**: a later process that omits `--enable-governed-tool` still offers it (tested).
- A booking change lives only in memory, so the next CLI process starts from the fixture again. The session and the
  audit log persist.
- **Not examined:** only `beforeTool` and `afterTool` (nothing here says another hook fails closed); *why* a refused call
  emits no `tool_execution_start` (measured, not explained); more than one live run per scenario.
- Provider/connection problems: see [Lab 01](../lab-01-pi-agent-loop/README.md).

## Where things are

```text
src/tool-policy.ts             the two rules: cancellation always blocked; a delivered booking is locked
src/governance-hooks.ts        beforeTool (policy + audit), afterTool (audit), and the extension bundling tool + hooks
src/update-booking-status-tool.ts, get-booking-tool.ts   the governed tool and the read-only one
src/audit-log.ts, create-harness.ts   AuditLog with an injectable writer; registry, the stored tool offer, onReport
src/harness-trace-logger.ts    run/turn trace; code= on errors, ⊘ tool_refused
scripts/tool-governance-demo.ts           the live experiment
tests/governance-pipeline.test.ts         the core offline proof: a real harness over a scripted model
```
