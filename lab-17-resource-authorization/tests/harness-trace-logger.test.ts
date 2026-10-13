import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadDirectoryFixture } from "../src/directory.js";
import { BACKGROUND_CONTEXT, crashChildMidTool, fauxAssistantMessage, readThenAnswer, startRuntime, updateThenAnswer, type TestRuntime } from "./helpers.js";

/**
 * The tracer is what a reader uses to tell *why* a tool call ended the way it did. These run the real
 * ChatService against a scripted provider and assert on the lines the tracer rendered, never on a
 * hand-built event.
 */
let rt: TestRuntime | undefined;
let dir: string | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const lineWith = (trace: string[], ...needles: string[]) => trace.filter((line) => needles.every((needle) => line.includes(needle)));
const depth = (line: string) => (line.length - line.trimStart().length) / 2;

describe("a successful call", () => {
  it("shows the model's request with its arguments, then the execution, paired by call id", async () => {
    rt = await startRuntime();
    rt.script(readThenAnswer("BK1001", "Two containers."));
    await rt.app.chat.chat(rt.as("alice"), { message: "Where is BK1001?" }, BACKGROUND_CONTEXT);

    const [request] = lineWith(rt.trace, "assistant (tool call) get_booking");
    expect(request).toContain('args={"bookingNo":"BK1001"}');
    const callId = /call=(\S+)/.exec(request ?? "")?.[1];
    expect(callId).toBeTruthy();
    expect(lineWith(rt.trace, "▶ tool_start get_booking", `call=${callId}`, 'args={"bookingNo":"BK1001"}')).toHaveLength(1);
    expect(lineWith(rt.trace, "◀ tool_end get_booking", `call=${callId}`, "status=success")).toHaveLength(1);
    expect(rt.trace.some((line) => line.includes("⊘"))).toBe(false);
  });

  it("nests run > turn > tool lines and closes every span it opened", async () => {
    rt = await startRuntime();
    rt.script(readThenAnswer("BK1001", "Done."));
    await rt.app.chat.chat(rt.as("alice"), { message: "Where is BK1001?" }, BACKGROUND_CONTEXT);

    const run = rt.trace.find((line) => line.includes("▶ run"));
    const turn = rt.trace.find((line) => line.includes("▶ turn #1"));
    const toolStart = rt.trace.find((line) => line.includes("▶ tool_start"));
    expect(depth(turn ?? "")).toBe(depth(run ?? "") + 1);
    expect(depth(toolStart ?? "")).toBe(depth(turn ?? "") + 1);
    expect(lineWith(rt.trace, "◀ turn_end")).toHaveLength(2);
    expect(lineWith(rt.trace, "◀ run_end")).toHaveLength(1);
    expect(depth(rt.trace.find((line) => line.includes("◀ run_end")) ?? "")).toBe(depth(run ?? ""));
  });
});

describe("the tool offer", () => {
  it.each([
    ["alice", "+[get_booking,update_booking_status]"],
    ["erin", "+[get_booking]"],
  ])("shows what %s was offered on the first run", async (subject, expected) => {
    rt = await startRuntime();
    rt.script([fauxAssistantMessage("Hello.")]);
    await rt.app.chat.chat(rt.as(subject), { message: "hi" }, BACKGROUND_CONTEXT);
    expect(lineWith(rt.trace, "system     tools", expected)).toHaveLength(1);
  });

  it("shows the removal when a reopened session is narrowed", async () => {
    rt = await startRuntime();
    rt.script([fauxAssistantMessage("Hello.")]);
    const first = await rt.app.chat.chat(rt.as("alice"), { message: "hi" }, BACKGROUND_CONTEXT);
    rt.app.directory.revoke("tenant-a", "alice", "operator");
    rt.app.directory.grant("tenant-a", "alice", "viewer");
    rt.script([fauxAssistantMessage("Hello again.")]);
    await rt.app.chat.chat(rt.as("alice"), { message: "hi again", sessionId: first.sessionId }, BACKGROUND_CONTEXT);
    expect(lineWith(rt.trace, "system     tools -[update_booking_status]")).toHaveLength(1);
  });
});

describe("a call the harness refused without running the tool", () => {
  it("a tool that is not offered is ⊘ tool_refused code=tool_unavailable, with no tool_start", async () => {
    rt = await startRuntime();
    rt.script(updateThenAnswer({ bookingNo: "BK5001", newStatus: "on_hold" }, "Not permitted."));
    await rt.app.chat.chat(rt.as("erin"), { message: "Hold BK5001" }, BACKGROUND_CONTEXT);

    expect(lineWith(rt.trace, "⊘ tool_refused update_booking_status", "code=tool_unavailable")).toHaveLength(1);
    expect(rt.trace.some((line) => line.includes("▶ tool_start"))).toBe(false);
    expect(lineWith(rt.trace, "toolResult update_booking_status", "status=error", "code=tool_unavailable")).toHaveLength(1);
  });

  it("arguments that fail the schema are ⊘ tool_refused code=invalid_arguments", async () => {
    rt = await startRuntime();
    rt.script(updateThenAnswer({ bookingNo: "BK1001", newStatus: "on_hold", tenantId: "tenant-b" }, "Rejected."));
    await rt.app.chat.chat(rt.as("alice"), { message: "Hold BK1001" }, BACKGROUND_CONTEXT);

    expect(lineWith(rt.trace, "⊘ tool_refused update_booking_status", "code=invalid_arguments")).toHaveLength(1);
    expect(lineWith(rt.trace, "assistant (tool call) update_booking_status", '"tenantId":"tenant-b"')).toHaveLength(1);
    expect(rt.trace.some((line) => line.includes("▶ tool_start"))).toBe(false);
  });
});

describe("an authorization denial is a different line from a capability refusal", () => {
  it("runs the tool, ends with status=error code=tool_error, and carries the reason the model received", async () => {
    rt = await startRuntime();
    rt.script(updateThenAnswer({ bookingNo: "BK2001", newStatus: "on_hold" }, "Not found."));
    await rt.app.chat.chat(rt.as("alice"), { message: "Hold BK1001" }, BACKGROUND_CONTEXT);

    expect(lineWith(rt.trace, "▶ tool_start update_booking_status", '"bookingNo":"BK2001"')).toHaveLength(1);
    const [end] = lineWith(rt.trace, "◀ tool_end update_booking_status");
    expect(end).toContain("status=error");
    expect(end).toContain("code=tool_error");
    expect(end).toContain('reason="No booking found for: BK2001"');
    expect(rt.trace.some((line) => line.includes("⊘"))).toBe(false);
  });
});

describe("recovery", () => {
  const reassigned = () => loadDirectoryFixture().bookings.map((b) => (b.tenantId === "tenant-a" && b.bookingNo === "BK1001" ? { ...b, ownerSubject: "bob" } : b));

  it("marks the run and turn that began before the restart", async () => {
    const crashed = await crashChildMidTool("get_booking");
    dir = crashed.dir;
    rt = await startRuntime({ dir });
    rt.script([fauxAssistantMessage("It is on ALPHA EXPRESS.")]);
    await rt.app.chat.resume(rt.as("alice"), crashed.sessionId, BACKGROUND_CONTEXT);

    expect(lineWith(rt.trace, "↺ ▶ run (began before the restart)")).toHaveLength(1);
    expect(lineWith(rt.trace, "↺ ▶ turn #1 (began before the restart)")).toHaveLength(1);
    expect(lineWith(rt.trace, "◀ run_end")).toHaveLength(1);
  });

  it("shows a safe read re-executed by recovery as a normal tool_end — never as a refusal", async () => {
    const crashed = await crashChildMidTool("get_booking");
    dir = crashed.dir;
    rt = await startRuntime({ dir });
    rt.script([fauxAssistantMessage("It is on ALPHA EXPRESS.")]);
    await rt.app.chat.resume(rt.as("alice"), crashed.sessionId, BACKGROUND_CONTEXT);

    const [end] = lineWith(rt.trace, "◀ tool_end get_booking");
    expect(end).toContain("status=success");
    expect(end).toContain("no tool_start in this process: re-executed by recovery");
    expect(rt.trace.some((line) => line.includes("⊘"))).toBe(false);
  });

  it("shows a re-executed read that authorization now denies as an error with its reason, not as a refusal", async () => {
    const crashed = await crashChildMidTool("get_booking");
    dir = crashed.dir;
    rt = await startRuntime({ dir, bookings: reassigned() });
    rt.script([fauxAssistantMessage("I cannot see it.")]);
    await rt.app.chat.resume(rt.as("alice"), crashed.sessionId, BACKGROUND_CONTEXT);

    const [end] = lineWith(rt.trace, "◀ tool_end get_booking");
    expect(end).toContain("status=error");
    expect(end).toContain('reason="No booking found for: BK1001"');
    expect(rt.trace.some((line) => line.includes("⊘"))).toBe(false);
  });

  it("shows an interrupted write as ↺ tool_interrupted, not as success and not as a refusal", async () => {
    const crashed = await crashChildMidTool("update_booking_status");
    dir = crashed.dir;
    rt = await startRuntime({ dir });
    rt.script([fauxAssistantMessage("The change was not confirmed.")]);
    await rt.app.chat.resume(rt.as("alice"), crashed.sessionId, BACKGROUND_CONTEXT);

    expect(lineWith(rt.trace, "↺ tool_interrupted update_booking_status", "code=interrupted")).toHaveLength(1);
    expect(rt.trace.some((line) => line.includes("⊘ tool_refused"))).toBe(false);
    expect(rt.trace.some((line) => line.includes("status=success") && line.includes("update_booking_status"))).toBe(false);
  });

  it("does not render the transcript of earlier processes as if it had just happened", async () => {
    const crashed = await crashChildMidTool("get_booking");
    dir = crashed.dir;
    rt = await startRuntime({ dir });
    rt.script([fauxAssistantMessage("It is on ALPHA EXPRESS.")]);
    await rt.app.chat.resume(rt.as("alice"), crashed.sessionId, BACKGROUND_CONTEXT);

    expect(rt.trace.some((line) => line.includes("Where is BK1001?"))).toBe(false);
    expect(rt.trace.some((line) => line.includes("assistant (tool call) get_booking"))).toBe(false);
  });
});

describe("what the tracer must not print", () => {
  it("never prints a delegated credential, even on a downstream failure", async () => {
    rt = await startRuntime({ connectorOverrides: { audience: "api://some-other-service" } });
    rt.script(updateThenAnswer({ bookingNo: "BK1001", newStatus: "on_hold" }, "It failed."));
    await rt.app.chat.chat(rt.as("alice"), { message: "Hold BK1001" }, BACKGROUND_CONTEXT);
    const text = rt.trace.join("\n");
    expect(text).toContain("Booking system rejected the request (unauthorized).");
    expect(text).not.toMatch(/eyJ|bearer/i);
  });

  it("does not print the booking's contents on a read (only the call and its outcome)", async () => {
    rt = await startRuntime();
    rt.script(readThenAnswer("BK1001", "Done."));
    await rt.app.chat.chat(rt.as("alice"), { message: "Where is BK1001?" }, BACKGROUND_CONTEXT);
    for (const marker of rt.app.store.markersFor("tenant-a", "BK1001")) expect(rt.trace.join("\n")).not.toContain(marker);
  });
});

