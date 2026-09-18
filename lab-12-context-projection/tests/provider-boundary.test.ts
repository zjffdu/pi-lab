import { createCustomMessage, type AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import { createGuardedToProviderMessages, type ProviderBoundaryViolation } from "../src/provider-boundary.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

describe("createGuardedToProviderMessages (network-free)", () => {
  it("reports zero violations when no forbidden substring appears anywhere", () => {
    const violations: ProviderBoundaryViolation[] = [];
    const guarded = createGuardedToProviderMessages(["SECRET-1"], (violation) => violations.push(violation));

    const messages: AgentMessage[] = [
      userMessage("What is the status of booking BK1001?"),
      createCustomMessage(
        "case_note",
        "Case note CN-001 on booking BK1001: customer asked for an update.",
        true,
        undefined,
        Date.now(),
      ),
    ];

    const result = guarded(messages, BACKGROUND_CONTEXT);
    expect(violations).toHaveLength(0);
    expect(result).toHaveLength(2);
  });

  it("reports exactly one violation, at the right message index, when a forbidden substring leaks into a custom message", () => {
    const violations: ProviderBoundaryViolation[] = [];
    const guarded = createGuardedToProviderMessages(["SECRET-DISCOUNT-9911"], (violation) => violations.push(violation));

    const messages: AgentMessage[] = [
      userMessage("What is the status of booking BK1001?"),
      createCustomMessage(
        "case_note",
        "Case note CN-001 on booking BK1001: authorized discount code SECRET-DISCOUNT-9911.",
        true,
        undefined,
        Date.now(),
      ),
    ];

    const result = guarded(messages, BACKGROUND_CONTEXT);
    expect(violations).toEqual([{ messageIndex: 1, matchedText: "SECRET-DISCOUNT-9911" }]);
    expect(result).toHaveLength(2);
  });

  it("is a pure check, not a corrector — a leak it reports is still present, unmodified, in the returned provider messages", () => {
    const violations: ProviderBoundaryViolation[] = [];
    const guarded = createGuardedToProviderMessages(["SECRET-2"], (violation) => violations.push(violation));

    const messages: AgentMessage[] = [createCustomMessage("case_note", "leaked SECRET-2 here", true, undefined, Date.now())];

    const result = guarded(messages, BACKGROUND_CONTEXT);
    expect(violations).toHaveLength(1);
    expect(JSON.stringify(result)).toContain("SECRET-2");
  });

  it("runs zero checks and reports zero violations when forbiddenSubstrings is empty — this lab's default, off state", () => {
    const violations: ProviderBoundaryViolation[] = [];
    const guarded = createGuardedToProviderMessages([], (violation) => violations.push(violation));

    const messages: AgentMessage[] = [
      createCustomMessage("case_note", "this contains a secret-looking string SECRET-3 too", true, undefined, Date.now()),
    ];

    guarded(messages, BACKGROUND_CONTEXT);
    expect(violations).toHaveLength(0);
  });
});
