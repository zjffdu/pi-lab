import { describe, expect, it } from "vitest";

import { InvalidActionArgumentsError, actionDigest, canonicalJson, normalizeArguments } from "../src/action-digest.js";
import { ACTION_STATES, TERMINAL_STATES, fromStates, nextState, type ActionEvent } from "../src/action-state.js";

const base = { tenantId: "tenant-a", requester: "alice", bookingNo: "BK1001", newStatus: "on_hold", reason: "customs hold", baseVersion: 1 };

describe("action digest", () => {
  it("is stable and independent of key order", () => {
    expect(actionDigest(base)).toBe(actionDigest({ baseVersion: 1, reason: "customs hold", newStatus: "on_hold", bookingNo: "BK1001", requester: "alice", tenantId: "tenant-a" }));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it.each([
    ["tenant", { tenantId: "tenant-b" }],
    ["requester", { requester: "dave" }],
    ["booking", { bookingNo: "BK2001" }],
    ["target status", { newStatus: "cancelled" }],
    ["reason", { reason: "customs hold, expedite" }],
    ["resource version", { baseVersion: 2 }],
  ])("changes when the %s changes", (_name, change) => {
    expect(actionDigest({ ...base, ...change })).not.toBe(actionDigest(base));
  });

  it("normalizes spelling variants to one action", () => {
    const a = normalizeArguments({ bookingNo: " bk1001 ", newStatus: "On_Hold", reason: "  customs hold " });
    expect(a).toEqual({ bookingNo: "BK1001", newStatus: "on_hold", reason: "customs hold" });
  });

  it("rejects values outside the allowed set", () => {
    expect(() => normalizeArguments({ bookingNo: "BK1001", newStatus: "teleported", reason: "x" })).toThrow(InvalidActionArgumentsError);
    expect(() => normalizeArguments({ bookingNo: "BK 1001;--", newStatus: "booked", reason: "x" })).toThrow(InvalidActionArgumentsError);
    expect(() => normalizeArguments({ bookingNo: "BK1001", newStatus: "booked", reason: "   " })).toThrow(InvalidActionArgumentsError);
  });
});

describe("action state machine", () => {
  const events: ActionEvent[] = ["approve", "reject", "expire", "revoke", "invalidate", "execute"];

  it("allows the documented transitions", () => {
    expect(nextState("pending", "approve")).toBe("approved");
    expect(nextState("pending", "reject")).toBe("rejected");
    expect(nextState("approved", "execute")).toBe("executed");
    expect(nextState("approved", "revoke")).toBe("revoked");
    expect(nextState("pending", "expire")).toBe("expired");
    expect(nextState("approved", "expire")).toBe("expired");
  });

  it("cannot execute anything that is not approved", () => {
    for (const state of ACTION_STATES) {
      if (state !== "approved") expect(nextState(state, "execute")).toBeUndefined();
    }
  });

  it("has no transition out of a terminal state", () => {
    for (const state of TERMINAL_STATES) {
      for (const event of events) expect(nextState(state, event)).toBeUndefined();
    }
  });

  it("exposes the same guard the SQL uses", () => {
    expect(fromStates("execute")).toEqual(["approved"]);
  });
});
