import { CaseNote, type CaseNoteData } from "../src/case-note-entries.js";
import type { IntegratedRunResult } from "../src/run-result.js";
import {
  answerTurn,
  cleanupTempDirs,
  ctx,
  declaredTools,
  scriptedRuntime,
  toolCallTurn,
} from "../tests/support/scripted-runtime.js";

/**
 * Scripted (no network, no live model) walk-through of Lab 15 on Pi 1.1. Each scenario prints what one request
 * leaves behind: the improved trace (every line tagged with the request id; refused calls drawn as
 * `⊘ tool_refused code=…`), the structured result, the audit trail, what the provider received, and the spans.
 * Read it next to README.md's findings.
 */

type Harness = Awaited<ReturnType<typeof scriptedRuntime>>;
const heading = (text: string) => console.log(`\n${"=".repeat(78)}\n${text}\n${"=".repeat(78)}`);
const trace = (line: string) => console.log(`  | ${line}`);

function show(h: Harness, result: IntegratedRunResult): void {
  const { correlation, operation, assistantAnswer, toolOutcomes, businessEffects, mechanism, deduplicated } = result;
  console.log("[result]");
  console.log(`  correlation   ${JSON.stringify(correlation)}`);
  console.log(`  operation     ${JSON.stringify(operation)}${deduplicated ? " (deduplicated)" : ""}`);
  console.log(`  answer        ${JSON.stringify(assistantAnswer ?? null)}`);
  console.log(`  toolOutcomes  ${JSON.stringify(toolOutcomes.map((o) => `${o.toolName}:${o.status}${o.code ? `(${o.code})` : ""}`))}`);
  console.log(`  effects       ${JSON.stringify(businessEffects.map((e) => `${e.bookingNo} ${e.previousStatus}->${e.newStatus} containers=${e.containerNos.join("+")}`))}`);
  console.log(`  mechanism     ${JSON.stringify(mechanism)}`);
  console.log("[audit]");
  for (const r of h.runtime.auditRecords) {
    console.log(`  ${r.phase.padEnd(11)} ${r.decision.padEnd(9)} ${r.toolName} task=${r.taskId} call=${r.toolCallId} action=${r.businessActionId ?? "-"} request=${r.requestId}`);
  }
  console.log(`[provider] requests=${h.faux.state.callCount}`);
  h.providerRequests.forEach((messages, i) =>
    console.log(`  #${i + 1} roles=${JSON.stringify(messages.map((m) => m.role))} tools=${JSON.stringify(declaredTools(messages))}`),
  );
  const spans = h.telemetry.getSpans();
  const depth = (s: (typeof spans)[number]): number => (s.parentId === null ? 0 : 1 + depth(spans.find((p) => p.id === s.parentId) ?? s));
  console.log("[spans]");
  for (const s of spans) console.log(`  ${"  ".repeat(depth(s))}${s.name} ${s.status.status}${s.attributes["lab.tool.name"] ? ` (${s.attributes["lab.tool.name"]} ${s.attributes["lab.tool.outcome"]})` : ""}`);
}

async function main(): Promise<void> {
  heading("1. Governed write, allowed — BK1001 has two containers; the status belongs to the booking");
  {
    const h = await scriptedRuntime({ trace });
    h.respondWith(
      toolCallTurn("get_booking", { bookingNo: "BK1001" }, "call-read"),
      toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "in_transit" }, "call-write"),
      answerTurn("BK1001 (containers MSKU1234567, MSKU2345678) is now in_transit."),
    );
    const result = await h.runtime.request("req-1", "Set BK1001 to in_transit.");
    await h.runtime.close();
    show(h, result);
  }

  heading("2. Governed write, blocked by policy — a refused call has no tool_start; the code says why");
  {
    const h = await scriptedRuntime({ trace });
    h.respondWith(toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "cancelled" }, "call-cancel"), answerTurn("That change was rejected."));
    const result = await h.runtime.request("req-2", "Cancel BK1001.");
    await h.runtime.close();
    show(h, result);
    console.log("  note: telemetry says 'refused'; only the audit line says the refusal was a policy decision.");
  }

  heading("3. Reopen: the application now offers read-only; the stored session offers read+write");
  {
    const first = await scriptedRuntime({ sessionId: "demo-reopen" });
    first.respondWith(answerTurn("hello back"));
    await first.runtime.request("req-3a", "hello");
    await first.runtime.close();
    const second = await scriptedRuntime({ sessionId: "demo-reopen", sessionsRoot: first.sessionsRoot, offeredToolNames: ["get_booking"], trace });
    console.log(`  toolSet ${JSON.stringify(second.runtime.toolSet)}`);
    second.respondWith(toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "in_transit" }, "call-w"), answerTurn("I could not do that."));
    const result = await second.runtime.request("req-3b", "Set BK1001 to in_transit.");
    await second.runtime.close();
    show(second, result);
  }

  heading("4. Egress: a leaky entry in context, without and with the egress layers");
  {
    const secret = "SECRET-TOKEN-9931";
    const note: CaseNoteData = { noteId: "n1", bookingNo: "BK1001", author: "ops", visibility: "shared", text: "Customer asked for an update.", internalOnly: `code ${secret}` };
    const leak = (h: Harness) =>
      h.runtime.root.commit(
        (tx) =>
          tx.appendEntry(CaseNote, h.runtime.root.id, {
            data: note,
            model: [{ role: "user", content: [{ type: "text", text: `${note.text} ${note.internalOnly}` }], timestamp: Date.now() }],
          }),
        ctx,
      );
    const variants = [
      ["no egress configuration", {}],
      ["preflight + backstop", { egress: { forbidden: [{ label: "internal-note-secret", value: secret }] } }],
      ["backstop only (preflight omitted)", { egress: { forbidden: [{ label: "internal-note-secret", value: secret }] }, omitForContractTest: ["egress-preflight" as const] }],
    ] as const;
    for (const [label, options] of variants) {
      console.log(`\n-- ${label}`);
      const h = await scriptedRuntime({ trace, ...options });
      await leak(h);
      h.respondWith(answerTurn("ok"));
      const result = await h.runtime.request("req-4", "Status of BK1001?");
      await h.runtime.close();
      show(h, result);
      console.log(`  provider saw the secret: ${h.providerRequests.some((m) => JSON.stringify(m).includes(secret))}`);
    }
  }

  heading("5. A reused request id is an idempotency key: the second prompt is not run");
  {
    const h = await scriptedRuntime({ trace });
    h.respondWith(answerTurn("first answer"));
    await h.runtime.request("req-5", "first prompt");
    const result = await h.runtime.request("req-5", "a different prompt");
    await h.runtime.close();
    show(h, result);
  }
}

try {
  await main();
} finally {
  await cleanupTempDirs();
}
