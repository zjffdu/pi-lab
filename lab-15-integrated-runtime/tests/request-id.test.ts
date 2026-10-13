import { describe, expect, it } from "vitest";

import { answerTurn, scriptedRuntime, toolCallTurn } from "./support/scripted-runtime.js";

/**
 * Pi 1.1 stores the application's `requestId` on the submission and uses it as a conversation-scoped
 * idempotency key. That is useful (a retried request is not run twice) and a trap (a *new* prompt with a reused
 * id is silently not run), so the composition root reports it instead of passing the old answer off as new.
 */
describe("a reused request id", () => {
  it("returns the original submission and answer, runs nothing new, and says so", async () => {
    const h = await scriptedRuntime();
    h.respondWith(answerTurn("first answer"), answerTurn("never requested"));

    const first = await h.runtime.request("req-1", "first prompt");
    const second = await h.runtime.request("req-1", "a completely different prompt");

    expect(second.deduplicated).toBe(true);
    expect(second.correlation.submissionId).toBe(first.correlation.submissionId);
    expect(second.assistantAnswer).toBe("first answer"); // not an answer to the second prompt
    expect(h.faux.state.callCount).toBe(1);
    expect(second.mechanism).toEqual({ ok: true, problems: [], checked: false }); // no new evidence was collected
    expect(first.deduplicated).toBeUndefined();
  });

  it("survives a restart: the key is durable, so the reopened runtime also returns the original", async () => {
    const first = await scriptedRuntime({ sessionId: "s-dedupe" });
    first.respondWith(answerTurn("first answer"));
    await first.runtime.request("req-1", "first prompt");
    await first.runtime.close();

    const second = await scriptedRuntime({ sessionId: "s-dedupe", sessionsRoot: first.sessionsRoot });
    second.respondWith(answerTurn("never requested"));
    const result = await second.runtime.request("req-1", "different prompt after restart");

    expect(result.deduplicated).toBe(true);
    expect(result.assistantAnswer).toBe("first answer");
    expect(second.faux.state.callCount).toBe(0);
    await second.runtime.close();
  });

  it("a different request id on the same prompt text runs normally", async () => {
    const h = await scriptedRuntime();
    h.respondWith(answerTurn("one"), answerTurn("two"));

    await h.runtime.request("req-1", "same");
    const second = await h.runtime.request("req-2", "same");

    expect(second.deduplicated).toBeUndefined();
    expect(second.assistantAnswer).toBe("two");
  });
});

describe("a request id whose submission has not settled", () => {
  it("is refused, not re-run and not reported as an answer, while the original request is still in flight", async () => {
    const h = await scriptedRuntime();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.faux.setResponses([
      async () => {
        started();
        await gate;
        return answerTurn("late answer");
      },
    ]);

    const inFlight = h.runtime.request("req-1", "slow prompt");
    await hasStarted;
    const second = await h.runtime.request("req-1", "again");
    release();
    const first = await inFlight;

    expect(second.operation).toMatchObject({ status: "rejected", errorCode: "request_unsettled" });
    expect(second.deduplicated).toBeUndefined();
    expect(second.assistantAnswer).toBeUndefined();
    expect(first.assistantAnswer).toBe("late answer");
    expect(h.faux.state.callCount).toBe(1);
  });
});

describe("one request's entries are not another's", () => {
  it("two requests that reuse the same tool-call id keep their own outcomes and effects, including when the first is read back later", async () => {
    const h = await scriptedRuntime();
    // The model chooses call ids, so "c1" can repeat across requests: call id alone cannot identify a call.
    h.respondWith(
      toolCallTurn("get_booking", { bookingNo: "BK1001" }, "c1"),
      answerTurn("first done"),
      toolCallTurn("update_booking_status", { bookingNo: "BK1001", newStatus: "in_transit" }, "c1"),
      answerTurn("second done"),
    );

    const first = await h.runtime.request("req-1", "read it");
    const second = await h.runtime.request("req-2", "change it");
    const firstAgain = await h.runtime.request("req-1", "read it"); // deduplicated: recomputed from durable entries after request 2 ran

    expect(first.toolOutcomes.map((o) => o.toolName)).toEqual(["get_booking"]);
    expect(first.businessEffects).toEqual([]);
    expect(second.toolOutcomes.map((o) => o.toolName)).toEqual(["update_booking_status"]);
    expect(second.businessEffects).toHaveLength(1);
    expect(second.mechanism.ok).toBe(true);
    expect(firstAgain.deduplicated).toBe(true);
    expect(firstAgain.toolOutcomes.map((o) => o.toolName)).toEqual(["get_booking"]);
    expect(firstAgain.businessEffects).toEqual([]); // request 2's effect is not attributed to request 1
  });
});
