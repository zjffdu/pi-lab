import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { AuditLog, type AuditRecord } from "../src/audit-log.js";
import {
  createBookingRegistry,
  GOVERNED_TOOL_NAME,
  modelSelectionFromEnvironment,
  offeredToolNames,
  openHarness,
} from "../src/create-harness.js";
import { attachTraceLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { errorDiagnostic, listEntries, messageText } from "../src/transcript.js";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));
const RUN_ID = Date.now();
const ctx = BACKGROUND_CONTEXT;
const models = builtinModels();

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function recordingAuditLog(shouldFail: (record: AuditRecord) => boolean = () => false) {
  const records: AuditRecord[] = [];
  const auditLog = new AuditLog((line) => {
    const record = JSON.parse(line) as AuditRecord;
    if (shouldFail(record)) {
      throw new Error(`Simulated audit-sink failure (${record.phase}).`);
    }
    records.push(record);
  });
  return { auditLog, records };
}

interface ScenarioOptions {
  name: string;
  expect: string;
  offerGovernedTool: boolean;
  simulatePolicyBug?: boolean;
  shouldFailAudit?: (record: AuditRecord) => boolean;
  prompts: string[];
}

async function runScenario(options: ScenarioOptions) {
  const sessionId = `tool-governance-${options.name}-${RUN_ID}`;
  console.log(`\n########## Scenario: ${options.name} (session=${sessionId}) ##########`);
  console.log(`[Expect] ${options.expect}`);

  const { auditLog, records } = recordingAuditLog(options.shouldFailAudit);
  const booking = createBookingRegistry({
    sessionId,
    auditLog,
    simulatePolicyBug: options.simulatePolicyBug,
  });
  const statusBefore = Object.fromEntries(booking.repository.all().map((each) => [each.bookingNo, each.status]));

  const reports: unknown[] = [];
  const { storage } = await openSessionStorage(SESSIONS_ROOT, sessionId, ctx);
  const { harness, root } = await openHarness(
    storage,
    {
      models,
      selection: modelSelectionFromEnvironment(),
      booking,
      offerGovernedTool: options.offerGovernedTool,
      onReport: (error) => {
        reports.push(error);
        console.log(`[Report] ${error instanceof Error ? error.message : String(error)}`);
      },
    },
    ctx,
  );
  const offered = await offeredToolNames(root, ctx);
  console.log(`[Harness] offeredTools=${JSON.stringify(offered)}`);

  const trace = await attachTraceLogger(harness, root.id, (line) => console.log(line), ctx);
  const answers: string[] = [];
  for (const prompt of options.prompts) {
    console.log(`[User] ${prompt}`);
    const settled = await (await root.submit({ type: "input", content: prompt }, ctx)).wait(ctx);
    await trace.settled(settled.id);
    assert(settled.status === "done", `${options.name}: every turn must settle done, got ${settled.status}`);
  }
  await trace.stop();

  const entries = await listEntries(root, ctx);
  const outcomes = entries
    .filter((entry) => entry.kind === "pi.tool-result")
    .map((entry) => ({ tool: (entry.model?.[0] as { toolName?: string } | undefined)?.toolName ?? "?", code: errorDiagnostic(entry)?.code ?? "ok" }));
  const lastAssistant = entries.filter((entry) => entry.kind === "pi.assistant").at(-1);
  answers.push(lastAssistant?.model?.[0] ? messageText(lastAssistant.model[0]) : "");
  console.log(`[Final answer] ${answers[0]}`);

  const statusAfter = Object.fromEntries(booking.repository.all().map((each) => [each.bookingNo, each.status]));
  const changed = Object.keys(statusAfter).filter((bookingNo) => statusAfter[bookingNo] !== statusBefore[bookingNo]);
  const unfinishedTasks = (await harness.inspect(ctx)).tasks.length;
  await harness.close(ctx);

  return { options, offered, records, reports, outcomes, changed, statusAfter, unfinishedTasks };
}

const governedOutcomes = (result: Awaited<ReturnType<typeof runScenario>>) =>
  result.outcomes.filter((outcome) => outcome.tool === GOVERNED_TOOL_NAME).map((outcome) => outcome.code);

async function main(): Promise<void> {
  const evidence: Record<string, string | number | boolean>[] = [];

  // A — not offered. The tool is registered; the conversation just does not offer it.
  const disabled = await runScenario({
    name: "disabled",
    expect:
      "update_booking_status is not offered, so it is not in the declarations the model receives. Whatever the " +
      "model says, no status changes and beforeTool never writes an audit record; if it tries the tool anyway, " +
      "the result is tool_unavailable.",
    offerGovernedTool: false,
    prompts: ["Please cancel booking BK1002, the customer no longer needs it."],
  });
  assert(!disabled.offered.includes(GOVERNED_TOOL_NAME), "disabled: the governed tool must not be offered");
  assert(disabled.records.length === 0, `disabled: expected zero audit records, got ${disabled.records.length}`);
  assert(disabled.changed.length === 0, `disabled: no booking may change, changed ${disabled.changed.join(",")}`);
  assert(
    governedOutcomes(disabled).every((code) => code === "tool_unavailable"),
    `disabled: any attempt at the governed tool must be tool_unavailable, got ${governedOutcomes(disabled).join(",")}`,
  );
  evidence.push({
    scenario: "disabled",
    audit: disabled.records.length,
    changed: disabled.changed.length,
    governedCalls: governedOutcomes(disabled).join(",") || "none",
    reported: disabled.reports.length,
  });

  // B — offered, normal policy, normal audit. Three turns, three different bookings.
  const normal = await runScenario({
    name: "enabled-normal",
    expect:
      "Cancelling BK1002 is blocked by the arg rule; changing delivered BK1003 is blocked by the state rule; " +
      "moving BK1001 to in_transit is allowed and executed. Two blocked, one allowed, one executed audit record.",
    offerGovernedTool: true,
    prompts: [
      "Please cancel booking BK1002.",
      "Please mark booking BK1003 as in_transit.",
      "Please mark booking BK1001 as in_transit.",
    ],
  });
  const blocked = normal.records.filter((record) => record.decision === "blocked");
  assert(governedOutcomes(normal).join(",") === "blocked,blocked,ok", `enabled-normal: outcomes ${governedOutcomes(normal).join(",")}`);
  assert(normal.statusAfter.BK1002 === "booked", "enabled-normal: BK1002 must stay booked");
  assert(normal.statusAfter.BK1003 === "delivered", "enabled-normal: BK1003 must stay delivered");
  assert(normal.statusAfter.BK1001 === "in_transit", "enabled-normal: BK1001 must become in_transit");
  assert(blocked.length === 2, `enabled-normal: expected 2 blocked records, got ${blocked.length}`);
  assert(blocked.some((record) => /not permitted/i.test(record.reason ?? "")), "enabled-normal: a block must cite the cancellation rule");
  assert(blocked.some((record) => /already delivered/i.test(record.reason ?? "")), "enabled-normal: a block must cite the delivered lock");
  assert(normal.records.filter((record) => record.decision === "allowed").length === 1, "enabled-normal: expected 1 allowed record");
  assert(normal.records.filter((record) => record.decision === "executed").length === 1, "enabled-normal: expected 1 executed record");
  assert(normal.reports.length === 0, `enabled-normal: expected no swallowed hook failure, got ${normal.reports.length}`);
  evidence.push({
    scenario: "enabled-normal",
    audit: normal.records.length,
    changed: normal.changed.length,
    governedCalls: governedOutcomes(normal).join(","),
    reported: normal.reports.length,
  });

  // C — the policy hook itself throws.
  const bug = await runScenario({
    name: "policy-bug",
    expect:
      "beforeTool throws before it audits anything. The harness turns the throw into a block: code blocked, no " +
      "effect, zero audit records.",
    offerGovernedTool: true,
    simulatePolicyBug: true,
    prompts: ["Please mark booking BK1002 as in_transit."],
  });
  assert(governedOutcomes(bug).join(",") === "blocked", `policy-bug: outcomes ${governedOutcomes(bug).join(",")}`);
  assert(bug.changed.length === 0, "policy-bug: no booking may change");
  assert(bug.records.length === 0, `policy-bug: the hook throws before auditing, expected 0 records, got ${bug.records.length}`);
  evidence.push({
    scenario: "policy-bug",
    audit: bug.records.length,
    changed: bug.changed.length,
    governedCalls: governedOutcomes(bug).join(","),
    reported: bug.reports.length,
  });

  // D — the audit sink fails in beforeTool.
  const sinkBefore = await runScenario({
    name: "audit-sink-fails-before-tool",
    expect:
      "Every audit write throws. beforeTool cannot record its decision, so even a transition the policy would " +
      "allow is blocked: code blocked, no effect.",
    offerGovernedTool: true,
    shouldFailAudit: () => true,
    prompts: ["Please mark booking BK1001 as in_transit."],
  });
  assert(governedOutcomes(sinkBefore).join(",") === "blocked", `audit-sink-fails-before-tool: outcomes ${governedOutcomes(sinkBefore).join(",")}`);
  assert(sinkBefore.changed.length === 0, "audit-sink-fails-before-tool: no booking may change");
  evidence.push({
    scenario: "audit-sink-fails-before-tool",
    audit: sinkBefore.records.length,
    changed: sinkBefore.changed.length,
    governedCalls: governedOutcomes(sinkBefore).join(","),
    reported: sinkBefore.reports.length,
  });

  // E — the audit sink fails only in afterTool.
  const sinkAfter = await runScenario({
    name: "audit-sink-fails-after-tool",
    expect:
      "beforeTool audits and allows; execute() mutates the booking; only then does the afterTool audit write " +
      "throw. The harness swallows it: the call still succeeds, the effect stands, the audit trail has a gap, " +
      "and the failure surfaces only through onReport.",
    offerGovernedTool: true,
    shouldFailAudit: (record) => record.phase === "after_tool",
    prompts: ["Please mark booking BK1002 as in_transit."],
  });
  assert(governedOutcomes(sinkAfter).join(",") === "ok", `audit-sink-fails-after-tool: outcomes ${governedOutcomes(sinkAfter).join(",")}`);
  assert(sinkAfter.statusAfter.BK1002 === "in_transit", "audit-sink-fails-after-tool: the effect must stand");
  assert(
    sinkAfter.records.map((record) => `${record.phase}:${record.decision}`).join(",") === "before_tool:allowed",
    "audit-sink-fails-after-tool: only the before_tool record may exist",
  );
  assert(sinkAfter.reports.length === 1, `audit-sink-fails-after-tool: expected 1 onReport entry, got ${sinkAfter.reports.length}`);
  assert(sinkAfter.unfinishedTasks === 0, "audit-sink-fails-after-tool: nothing may be left unfinished");
  evidence.push({
    scenario: "audit-sink-fails-after-tool",
    audit: sinkAfter.records.length,
    changed: sinkAfter.changed.length,
    governedCalls: governedOutcomes(sinkAfter).join(","),
    reported: sinkAfter.reports.length,
  });

  console.log("\n########## Evidence summary ##########");
  console.table(evidence);
  console.log("\n=== All Lab 13 tool-governance assertions passed ===");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
