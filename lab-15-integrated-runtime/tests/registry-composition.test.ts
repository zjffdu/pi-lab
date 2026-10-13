import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { createMemoryAuditLog } from "../src/audit-log.js";
import { RequestBindings } from "../src/correlation.js";
import { createBookingRegistry, offeredToolNames, openHarness } from "../src/create-harness.js";
import { EffectLedger } from "../src/effect-ledger.js";
import { GOVERNANCE_EXTENSION_NAME } from "../src/governance-hooks.js";
import { openSessionStorage } from "../src/session-store.js";
import { errorDiagnostic, listEntries } from "../src/transcript.js";
import { answerTurn, ctx, tempSessionsRoot, toolCallTurn } from "./support/scripted-runtime.js";

/**
 * The claims that rest on how Lab 15's OWN registry is assembled, tested against `createBookingRegistry` and
 * `openHarness` directly (not a hand-built registry, which would only prove something about Pi): the governance
 * extension carries both tools together with the hooks that guard them, and its hook is global to every tool.
 */

function parts() {
  const { auditLog, records } = createMemoryAuditLog();
  const booking = createBookingRegistry({ sessionId: "s", auditLog, bindings: new RequestBindings(), effects: new EffectLedger() });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { booking, records, faux, models, selection: { provider: model.provider, modelId: model.id } };
}

describe("the governance extension's hook is global: it governs a tool that lives in another extension", () => {
  it("a third tool installed elsewhere and offered to the model is blocked by the deny-by-default table, and audited", async () => {
    const { booking, records, faux, models, selection } = parts();
    let executed = 0;
    const containerEvents = defineTool({
      name: "get_container_events",
      description: "A third tool added by a developer who did not touch the policy table.",
      parameters: Type.Object({ bookingNo: Type.String() }, { additionalProperties: false }),
      replay: "safe",
      async execute() {
        executed += 1;
        return { content: [{ type: "text", text: "events" }] };
      },
    });
    booking.registry.install(defineExtension({ name: "container-events", tools: [containerEvents] }));
    const storage = (await openSessionStorage(await tempSessionsRoot(), "third-tool", ctx)).storage;
    const { harness, root } = await openHarness(storage, { models, selection, booking }, ctx);
    await root.configure({ tools: [booking.tools.getBooking, booking.tools.updateBookingStatus, containerEvents] }, ctx);
    faux.setResponses([toolCallTurn("get_container_events", { bookingNo: "BK1001" }, "c1"), answerTurn("blocked")]);

    await (await root.submit({ type: "input", content: "events for BK1001?" }, ctx)).wait(ctx);

    const result = (await listEntries(root, ctx)).find((e) => e.kind === "pi.tool-result");
    expect(await offeredToolNames(root, ctx)).toEqual(["get_booking", "update_booking_status", "get_container_events"]);
    expect(errorDiagnostic(result)?.code).toBe("blocked");
    expect(executed).toBe(0);
    expect(records.map((r) => [r.toolName, r.phase, r.decision])).toEqual([["get_container_events", "before_tool", "blocked"]]);
    expect(records[0]?.reason).toMatch(/No policy is registered for tool "get_container_events"/);
    await harness.close(ctx);
  });
});

describe("the governance extension carries the tools: Lab 15's own registry without it has none", () => {
  it("installing only Lab 15's `booking` extension offers nothing, and a stored write call is refused as unavailable", async () => {
    // First session: the full registry, so the stored offer includes both tools.
    const full = parts();
    const sessionsRoot = await tempSessionsRoot();
    full.faux.setResponses([answerTurn("hello back")]);
    const first = await openHarness((await openSessionStorage(sessionsRoot, "bare", ctx)).storage, { models: full.models, selection: full.selection, booking: full.booking }, ctx);
    await (await first.root.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
    expect(await offeredToolNames(first.root, ctx)).toEqual(["get_booking", "update_booking_status"]);
    await first.harness.close(ctx);

    // Reopen with the SAME extension objects Lab 15 builds, minus the governance extension.
    const second = parts();
    const bare = createRegistry();
    bare.install(second.booking.extensions.booking);
    expect(GOVERNANCE_EXTENSION_NAME).toBe("booking-governance");
    const harness = await Harness.open(
      (await openSessionStorage(sessionsRoot, "bare", ctx)).storage,
      { models: second.models, registry: bare, settings: { compaction: { enabled: false, backgroundTokens: 0 } } },
      ctx,
    );
    const root = await harness.root(ctx);
    second.faux.setResponses([toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "in_transit" }, "c9"), answerTurn("done")]);

    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);

    const result = (await listEntries(root, ctx)).filter((e) => e.kind === "pi.tool-result").at(-1);
    expect(await offeredToolNames(root, ctx)).toEqual([]);
    expect(errorDiagnostic(result)?.code).toBe("tool_unavailable");
    expect(second.booking.repository.findByBookingNo("BK1001")?.status).toBe("booked");
    expect(second.records).toEqual([]);
    await harness.close(ctx);
  });
});
