/**
 * Runs the roadmap's prediction-gate scenario with a scripted provider: yesterday an operator used
 * the write tool in a session; today that permission is revoked and the same session is reopened.
 * Prints each day's trace tree (the committed events, including the model's tool-call arguments and
 * the change in the tool offer), what the booking system actually changed, and what the audit log
 * recorded.
 *
 * Deterministic and offline. The prediction is waived for this run (see WORKSHEET.md).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { createApp } from "../src/app.js";
import { readAuditLog } from "../src/audit-log.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";
import { mintSecurityContextForTest } from "../src/security-context.js";

const dir = await mkdtemp(join(tmpdir(), "pi-lab-17-demo-"));
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const app = await createApp({
  binding: { models, selection: { provider: model.provider, modelId: model.id } },
  dataDir: dir,
  trace: (line) => console.log(`  ${line}`),
});

const script = (args: Record<string, string>, answer: string) =>
  faux.setResponses([fauxAssistantMessage(fauxToolCall("update_booking_status", args), { stopReason: "toolUse" }), fauxAssistantMessage(answer)]);
const alice = (requestId: string) => mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId });

console.log("== Day 1: alice is an operator and owns BK1001 (two containers) ==");
script({ bookingNo: "BK1001", newStatus: "on_hold" }, "BK1001 is on hold.");
const day1 = await app.chat.chat(alice("day1"), { message: "Put BK1001 on hold." }, BACKGROUND_CONTEXT);
console.log({ offeredTools: day1.offeredTools, restoredOffer: day1.restoredOffer });

console.log("\n== An administrator revokes alice's operator role (she keeps viewer) ==");
app.directory.revoke("tenant-a", "alice", "operator");
app.directory.grant("tenant-a", "alice", "viewer");

console.log("\n== Day 2: the same session; the model tries the write again ==");
script({ bookingNo: "BK1001", newStatus: "cancelled" }, "I could not cancel it.");
const day2 = await app.chat.chat(alice("day2"), { message: "Cancel it.", sessionId: day1.sessionId }, BACKGROUND_CONTEXT);
console.log({ restoredOffer: day2.restoredOffer, offeredToolsNow: day2.offeredTools });
console.log("booking-system status changes:", app.store.statusChanges);
console.log("downstream requests handled:", app.downstream.log.length);

console.log("\n== Audit trail (kind/channel/actor/roles/decision/reason) ==");
for (const record of await readAuditLog(app.paths.auditPath)) {
  const detail = record.kind === "capabilities" ? `tools=${record.offeredTools.join(",") || "-"}` : `${record.action} ${record.resource.bookingNo} reason=${record.reason ?? "-"}`;
  console.log(`${record.kind.padEnd(12)} ${record.channel.padEnd(11)} ${record.actor} roles=[${record.roles}] ${record.decision} ${detail} policy=${record.policyVersion}`);
}

await app.close();
await rm(dir, { recursive: true, force: true });
