import { Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { BookingRepository } from "../src/booking-repository.js";
import { offeredToolNames, SYSTEM_PROMPT } from "../src/create-harness.js";
import { createGetBookingTool } from "../src/get-booking-tool.js";
import { openSessionStorage } from "../src/session-store.js";
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { errorDiagnostic, listEntries } from "../src/transcript.js";
import { answerTurn, ctx, declaredTools, scriptedRuntime, toolCallTurn } from "./support/scripted-runtime.js";

/**
 * Implementation step 3: close a session and reopen it. Every characterization was observed first (the
 * prediction gate was waived), then pinned — and several differ from the 0.85.1 version of this lab.
 */

const BOTH = ["get_booking", "update_booking_status"];
const READ_ONLY = ["get_booking"];
const WRITE = { bookingNo: "BK1001", newStatus: "in_transit" } as const;

/** Runs one request, closes, and returns the shared sessions root so a second runtime can reopen it. */
async function firstSession(sessionId: string, offeredToolNames?: string[]) {
  const first = await scriptedRuntime({ sessionId, ...(offeredToolNames ? { offeredToolNames } : {}) });
  first.respondWith(answerTurn("hello back"));
  await first.runtime.request("req-first", "hello");
  await first.runtime.close();
  return first;
}

describe("what survives a reopen, and what does not", () => {
  it("conversation history survives: the next provider request carries the earlier messages", async () => {
    const first = await firstSession("s-history");
    const second = await scriptedRuntime({ sessionId: "s-history", sessionsRoot: first.sessionsRoot });
    second.respondWith(answerTurn("second answer"));

    await second.runtime.request("req-second", "again");

    const roles = second.providerRequests[0]?.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(second.runtime.inspection.tasks).toEqual([]); // nothing left unfinished
    await second.runtime.close();
  });

  it("business state does not survive: the booking repository is in-memory and starts from the fixture", async () => {
    const first = await scriptedRuntime({ sessionId: "s-state" });
    first.respondWith(toolCallTurn("update_booking_status", WRITE, "c1"), answerTurn("done"));
    await first.runtime.request("req-1", "Set BK1001 to in_transit.");
    expect(first.runtime.repository.findByBookingNo("BK1001")?.status).toBe("in_transit");
    await first.runtime.close();

    const second = await scriptedRuntime({ sessionId: "s-state", sessionsRoot: first.sessionsRoot });

    // The session history still says the change happened; the business system forgot it.
    expect(second.runtime.repository.findByBookingNo("BK1001")?.status).toBe("booked");
    await second.runtime.close();
  });
});

describe("what the session stores is names; the code comes from the registry", () => {
  /**
   * Reopens the same storage with a hand-built registry that has the prompt and a *separately installed* read
   * tool — and no governance. (Lab 15's own registry without governance is tested in `registry-composition.test.ts`.)
   */
  async function reopenWithoutGovernance(first: Awaited<ReturnType<typeof firstSession>>) {
    const repository = BookingRepository.fromDefaultFixture();
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "booking",
        tools: [createGetBookingTool(repository)],
        sections: [section("preamble", () => SYSTEM_PROMPT, { tag: false })],
      }),
    );
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const { storage } = await openSessionStorage(first.sessionsRoot, first.sessionId, ctx);
    const harness = await Harness.open(storage, { models, registry, settings: { compaction: { enabled: false, backgroundTokens: 0 } } }, ctx);
    const root = await harness.root(ctx);
    return { harness, root, faux, repository };
  }

  it("whereas a tool installed *separately* from its guard runs ungoverned and unaudited — the shape bundling rules out", async () => {
    const first = await firstSession("s-unbundled");
    const { harness, root, faux } = await reopenWithoutGovernance(first); // get_booking installed, no hooks anywhere
    faux.setResponses([toolCallTurn("get_booking", { bookingNo: "BK1001" }, "c9"), answerTurn("done")]);

    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);

    const result = (await listEntries(root, ctx)).filter((e) => e.kind === "pi.tool-result").at(-1);
    expect(result?.model?.[0]).toMatchObject({ role: "toolResult", isError: false }); // it ran, with no policy and no audit
    await harness.close(ctx);
  });

  it("reopening through the composition root governs the first tool call: the policy blocks the same cancellation", async () => {
    const first = await firstSession("s-governed");
    const second = await scriptedRuntime({ sessionId: "s-governed", sessionsRoot: first.sessionsRoot });
    second.respondWith(toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "cancelled" }, "c1"), answerTurn("rejected"));

    const result = await second.runtime.request("req-reopen-block", "Cancel BK1001");

    expect(second.runtime.repository.findByBookingNo("BK1001")?.status).toBe("booked");
    expect(result.businessEffects).toEqual([]);
    expect(second.runtime.auditRecords.map((r) => [r.phase, r.decision])).toEqual([["before_tool", "blocked"]]);
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true });
    await second.runtime.close();
  });

  it("an allowed write after reopen is audited before its effect and correlated to the new request", async () => {
    const first = await firstSession("s-allowed");
    const second = await scriptedRuntime({ sessionId: "s-allowed", sessionsRoot: first.sessionsRoot });
    second.respondWith(toolCallTurn("update_booking_status", WRITE, "c1"), answerTurn("done"));

    const result = await second.runtime.request("req-reopen-write", "Set BK1001 to in_transit.");

    expect(result.businessEffects).toHaveLength(1);
    expect(second.runtime.auditRecords.map((r) => r.phase)).toEqual(["before_tool", "after_tool"]);
    expect(second.runtime.auditRecords.every((r) => r.requestId === "req-reopen-write")).toBe(true);
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true });
    await second.runtime.close();
  });
});

describe("the offered tool set is stored, so the application must reconcile it", () => {
  it("Pi keeps the stored tool offer and ignores the one passed to root(): the runtime sees BOTH before it reconciles", async () => {
    const first = await firstSession("s-tools-bare"); // stored: both tools
    const second = await scriptedRuntime({ sessionId: "s-tools-bare", sessionsRoot: first.sessionsRoot, offeredToolNames: READ_ONLY });
    // `persisted` is read from Pi before the runtime reconciles it.
    expect(second.runtime.toolSet.persisted).toEqual(BOTH);
    await second.runtime.close();
  });

  it("the composition root reconciles to the current application configuration and records what it replaced", async () => {
    const first = await firstSession("s-tools-reconcile"); // stored: both tools
    const second = await scriptedRuntime({ sessionId: "s-tools-reconcile", sessionsRoot: first.sessionsRoot, offeredToolNames: READ_ONLY });
    second.respondWith(answerTurn("ok"));

    expect(second.runtime.toolSet).toEqual({ persisted: BOTH, desired: READ_ONLY, reconciled: true });
    expect(await offeredToolNames(second.runtime.root, ctx)).toEqual(READ_ONLY);

    await second.runtime.request("req-r", "hello");
    expect(declaredTools(second.providerRequests[0] ?? [])).toEqual(READ_ONLY); // the stored set was BOTH; the delta removed one
    await second.runtime.close();
  });

  it("when nothing changed, reconciliation is a no-op", async () => {
    const first = await firstSession("s-tools-same");
    const second = await scriptedRuntime({ sessionId: "s-tools-same", sessionsRoot: first.sessionsRoot });

    expect(second.runtime.toolSet).toEqual({ persisted: BOTH, desired: BOTH, reconciled: false });
    await second.runtime.close();
  });

  it("a write the model requests for a tool no longer offered has no effect, no audit record, and is not a mechanism failure", async () => {
    const first = await firstSession("s-tools-withdrawn");
    const second = await scriptedRuntime({ sessionId: "s-tools-withdrawn", sessionsRoot: first.sessionsRoot, offeredToolNames: READ_ONLY });
    second.respondWith(toolCallTurn("update_booking_status", WRITE, "c1"), answerTurn("could not"));

    const result = await second.runtime.request("req-withdrawn", "Set BK1001 to in_transit.");

    expect(result.businessEffects).toEqual([]);
    expect(second.runtime.repository.findByBookingNo("BK1001")?.status).toBe("booked");
    expect(result.toolOutcomes[0]).toMatchObject({ status: "unavailable", code: "tool_unavailable" });
    expect(second.runtime.auditRecords).toEqual([]); // it never reached beforeTool
    expect(result.mechanism).toEqual({ ok: true, problems: [], checked: true });
    await second.runtime.close();
  });
});
