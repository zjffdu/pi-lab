import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadDirectoryFixture } from "../src/directory.js";
import { BACKGROUND_CONTEXT, crashChildMidTool, fauxAssistantMessage, startRuntime, type TestRuntime } from "./helpers.js";

/**
 * A real process is killed with a tool call in flight (after the allow decision was audited,
 * before the effect), leaving a durable open operation. A second process — this test, with
 * different "today" state — resumes it. Lab 08/09 own the recovery mechanics; this file asks
 * only whether recovered work is re-authorized.
 */
let rt: TestRuntime | undefined;
let dir: string | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const withBookingOwner = (bookingNo: string, ownerSubject: string) =>
  loadDirectoryFixture().bookings.map((booking) => (booking.tenantId === "tenant-a" && booking.bookingNo === bookingNo ? { ...booking, ownerSubject } : booking));

describe("recovered execution applies current authorization", () => {
  it("re-executes an interrupted read under today's ownership, and is refused when the booking is no longer the caller's", async () => {
    const crashed = await crashChildMidTool("get_booking");
    dir = crashed.dir;
    rt = await startRuntime({ dir, bookings: withBookingOwner("BK1001", "bob") });
    rt.script([fauxAssistantMessage("I cannot see that booking.")]);

    const result = await rt.app.chat.resume(rt.as("alice"), crashed.sessionId, BACKGROUND_CONTEXT);

    expect(result.answer).toBe("I cannot see that booking.");
    // The rerun went through BookingService and was refused: an error result carrying the not-found text.
    expect(await rt.toolResults(rt.as("alice"), crashed.sessionId)).toMatchObject([{ toolName: "get_booking", isError: true, code: "tool_error", text: expect.stringContaining("No booking found for: BK1001") }]);
    expect(rt.providerRequests.map((request) => request.messages).join("")).not.toContain("ALPHA EXPRESS");

    const decisions = (await rt.audit()).filter((record) => record.kind === "decision");
    expect(decisions.map((record) => [record.decision, record.reason])).toEqual([
      ["allow", undefined], // the crashed process, before it died
      ["deny", "resource_not_visible"], // the recovered execution, under today's state
    ]);
  });

  it("re-executes an interrupted read that is still permitted", async () => {
    const crashed = await crashChildMidTool("get_booking");
    dir = crashed.dir;
    rt = await startRuntime({ dir });
    rt.script([fauxAssistantMessage("It is on ALPHA EXPRESS.")]);

    await rt.app.chat.resume(rt.as("alice"), crashed.sessionId, BACKGROUND_CONTEXT);

    expect(rt.providerRequests[0]?.messages).toContain("ALPHA EXPRESS");
    expect((await rt.audit()).filter((record) => record.kind === "decision").map((record) => record.decision)).toEqual(["allow", "allow"]);
  });

  it("does not restore a revoked write tool on resume, and does not re-run the interrupted write", async () => {
    const crashed = await crashChildMidTool("update_booking_status");
    dir = crashed.dir;
    rt = await startRuntime({ dir });
    rt.app.directory.revoke("tenant-a", "alice", "operator");
    rt.app.directory.grant("tenant-a", "alice", "viewer");
    rt.script([fauxAssistantMessage("The change was not confirmed.")]);

    const result = await rt.app.chat.resume(rt.as("alice"), crashed.sessionId, BACKGROUND_CONTEXT);

    expect(result.restoredOffer).toContain("update_booking_status"); // what the dead process left behind
    expect(result.offeredTools).toEqual(["get_booking"]);
    expect(rt.providerRequests[0]?.offered).toEqual(["get_booking"]);
    // `replay: "unsafe"`: recovery records the interrupted write as an `interrupted` error instead of executing it again.
    expect(await rt.toolResults(rt.as("alice"), crashed.sessionId)).toMatchObject([{ toolName: "update_booking_status", isError: true, code: "interrupted" }]);
    expect(rt.app.store.statusChanges).toEqual([]);
    expect(rt.app.downstream.log).toEqual([]);
    expect((await rt.audit()).filter((record) => record.kind === "decision")).toHaveLength(1); // only the pre-crash allow
  });

  it("positive control: with the role intact, the recovered request does offer the write tool", async () => {
    const crashed = await crashChildMidTool("update_booking_status");
    dir = crashed.dir;
    rt = await startRuntime({ dir });
    rt.script([fauxAssistantMessage("The change was not confirmed.")]);

    const result = await rt.app.chat.resume(rt.as("alice"), crashed.sessionId, BACKGROUND_CONTEXT);

    expect(result.offeredTools).toEqual(["get_booking", "update_booking_status"]);
    expect(rt.providerRequests[0]?.offered).toEqual(["get_booking", "update_booking_status"]);
    expect(rt.app.store.statusChanges).toEqual([]); // not re-run even when permitted: replay is "unsafe"
  });

  it("refuses to resume for a caller who is not the session's owner", async () => {
    const crashed = await crashChildMidTool("get_booking");
    dir = crashed.dir;
    rt = await startRuntime({ dir });
    await expect(rt.app.chat.resume(rt.as("bob"), crashed.sessionId, BACKGROUND_CONTEXT)).rejects.toThrow("Session not found.");
    expect(rt.providerRequests).toEqual([]);
  });
});
