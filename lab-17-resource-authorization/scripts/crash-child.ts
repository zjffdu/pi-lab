/**
 * Child process for the recovery experiment. It starts one scripted run in which alice's
 * `get_booking` call is authorized and then parks at a named checkpoint, so the parent can kill
 * the process with a durable operation left open. Test/demo use only.
 *
 * usage: node --import tsx scripts/crash-child.ts <dataDir> [get_booking|update_booking_status]
 */
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { createApp } from "../src/app.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";
import { mintSecurityContextForTest } from "../src/security-context.js";

const dataDir = process.argv[2];
if (!dataDir) throw new Error("usage: crash-child.ts <dataDir>");

const tool = process.argv[3] ?? "get_booking";
if (tool !== "get_booking" && tool !== "update_booking_status") throw new Error(`unknown tool ${tool}`);

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
faux.setResponses([
  fauxAssistantMessage(fauxToolCall(tool, tool === "get_booking" ? { bookingNo: "BK1001" } : { bookingNo: "BK1001", newStatus: "on_hold" }), { stopReason: "toolUse" }),
]);

const app = await createApp({
  binding: { models, selection: { provider: model.provider, modelId: model.id } },
  dataDir,
  afterAuthorization: async ({ action, bookingNo }) => {
    console.log(`[Checkpoint] authorized_before_effect action=${action} bookingNo=${bookingNo}`);
    await new Promise(() => undefined); // park until the parent kills this process
  },
});

await app.chat.chat(mintSecurityContextForTest({ tenantId: "tenant-a", subject: "alice", requestId: "child-1" }), { message: "Where is BK1001?" }, BACKGROUND_CONTEXT);
