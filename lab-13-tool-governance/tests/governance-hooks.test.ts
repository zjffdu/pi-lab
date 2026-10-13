import type { ToolCall } from "@earendil-works/pi-ai";
import type { HookApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { AuditLog } from "../src/audit-log.js";
import { BookingRepository } from "../src/booking-repository.js";
import {
  createAfterToolHook,
  createBeforeToolHook,
  createGovernanceExtension,
  GOVERNANCE_EXTENSION_NAME,
  GOVERNED_TOOL_NAME,
} from "../src/governance-hooks.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";
import { recordingAuditLog } from "./helpers.js";

/**
 * Deterministic, network-free proof of the two hook *functions* — the code this lab owns. What the
 * harness does with a hook's return value or throw (block vs allow, fail-closed vs fail-open) is proven
 * against a real harness in `governance-pipeline.test.ts`; this file only proves: given one synthetic
 * call, does this lab's hook make the right decision and write the right audit record.
 */

const api = { conversationId: 1, taskId: 12 } as unknown as HookApi;

function call(overrides: Partial<{ name: string; arguments: Record<string, unknown> }> = {}): ToolCall {
  return {
    type: "toolCall",
    id: "call-1",
    name: overrides.name ?? GOVERNED_TOOL_NAME,
    arguments: (overrides.arguments ?? { bookingNo: "BK1001", newStatus: "in_transit" }) as ToolCall["arguments"],
  };
}

function options(auditLog: AuditLog, extra: { simulatePolicyBug?: boolean } = {}) {
  return { sessionId: "session-1", auditLog, repository: BookingRepository.fromDefaultFixture(), ...extra };
}

describe("createBeforeToolHook", () => {
  it("ignores every other tool: no policy, no audit", async () => {
    const { auditLog, records } = recordingAuditLog();
    const result = await createBeforeToolHook(options(auditLog))(
      call({ name: "get_booking", arguments: { bookingNo: "BK1001" } }),
      api,
      BACKGROUND_CONTEXT,
    );

    expect(result).toBeUndefined();
    expect(records).toHaveLength(0);
  });

  it("allows an ordinary transition and audits the allow decision with the ids the hook was given", async () => {
    const { auditLog, records } = recordingAuditLog();
    const result = await createBeforeToolHook(options(auditLog))(call(), api, BACKGROUND_CONTEXT);

    expect(result).toBeUndefined();
    expect(records).toEqual([
      expect.objectContaining({
        phase: "before_tool",
        decision: "allowed",
        sessionId: "session-1",
        conversationId: 1,
        taskId: 12,
        toolCallId: "call-1",
        args: { bookingNo: "BK1001", newStatus: "in_transit" },
      }),
    ]);
  });

  it("blocks a prohibited cancellation with the policy's reason, and audits the block", async () => {
    const { auditLog, records } = recordingAuditLog();
    const result = await createBeforeToolHook(options(auditLog))(
      call({ arguments: { bookingNo: "BK1001", newStatus: "cancelled" } }),
      api,
      BACKGROUND_CONTEXT,
    );

    expect(result?.block).toMatch(/not permitted/i);
    expect(records[0]).toMatchObject({ phase: "before_tool", decision: "blocked" });
    expect(records[0]?.reason).toBe(result?.block);
  });

  it("blocks a change to a delivered booking — a two-container booking has one status, and it is locked as a whole", async () => {
    const { auditLog } = recordingAuditLog();
    const result = await createBeforeToolHook(options(auditLog))(
      call({ arguments: { bookingNo: "BK1003", newStatus: "in_transit" } }),
      api,
      BACKGROUND_CONTEXT,
    );

    expect(result?.block).toMatch(/already delivered/i);
  });

  it("simulatePolicyBug throws before policy is evaluated or anything is audited", async () => {
    const { auditLog, records } = recordingAuditLog();
    const hook = createBeforeToolHook(options(auditLog, { simulatePolicyBug: true }));

    await expect(hook(call(), api, BACKGROUND_CONTEXT)).rejects.toThrow(/simulated bug/i);
    expect(records).toHaveLength(0);
  });

  it("a throwing audit sink propagates out of the hook even for an otherwise-allowed call", async () => {
    const throwing = new AuditLog(() => {
      throw new Error("simulated audit-sink failure");
    });

    await expect(createBeforeToolHook(options(throwing))(call(), api, BACKGROUND_CONTEXT)).rejects.toThrow(
      "simulated audit-sink failure",
    );
  });
});

describe("createAfterToolHook", () => {
  const ok: ToolExecutionResult = { content: [{ type: "text", text: "{}" }] };

  it("ignores every other tool", async () => {
    const { auditLog, records } = recordingAuditLog();
    const result = await createAfterToolHook(options(auditLog))(call({ name: "get_booking" }), ok, api, BACKGROUND_CONTEXT);

    expect(result).toBeUndefined();
    expect(records).toHaveLength(0);
  });

  it("audits a successful execution as `executed` and never replaces the result", async () => {
    const { auditLog, records } = recordingAuditLog();
    const result = await createAfterToolHook(options(auditLog))(call(), ok, api, BACKGROUND_CONTEXT);

    expect(result).toBeUndefined();
    expect(records[0]).toMatchObject({ phase: "after_tool", decision: "executed", taskId: 12, toolCallId: "call-1" });
  });

  it("audits a tool-level error (e.g. unknown booking) as `errored`, distinct from a policy block", async () => {
    const { auditLog, records } = recordingAuditLog();
    await createAfterToolHook(options(auditLog))(call(), { ...ok, isError: true }, api, BACKGROUND_CONTEXT);

    expect(records[0]).toMatchObject({ phase: "after_tool", decision: "errored" });
  });

  it("a throwing audit sink propagates out of the function: what makes this fail-open is the harness's hook loop, not this code", async () => {
    const throwing = new AuditLog(() => {
      throw new Error("simulated audit-sink failure");
    });

    await expect(createAfterToolHook(options(throwing))(call(), ok, api, BACKGROUND_CONTEXT)).rejects.toThrow(
      "simulated audit-sink failure",
    );
  });
});

describe("createGovernanceExtension", () => {
  it("bundles the governed tool with its guard: one extension, one tool, and a ToolTask hook with both phases", () => {
    const { auditLog } = recordingAuditLog();
    const { extension, updateBookingStatusTool } = createGovernanceExtension(options(auditLog));

    expect(extension.name).toBe(GOVERNANCE_EXTENSION_NAME);
    expect(extension.tools?.map((tool) => tool.name)).toEqual([GOVERNED_TOOL_NAME]);
    expect(extension.tools?.[0]).toBe(updateBookingStatusTool);
    expect(extension.hooks).toHaveLength(1);
    expect(extension.hooks?.[0]?.task).toBe("pi.tool");
    expect(Object.keys(extension.hooks?.[0]?.handlers ?? {}).sort()).toEqual(["afterTool", "beforeTool"]);
  });
});
