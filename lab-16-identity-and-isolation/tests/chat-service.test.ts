import { withCancel } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { ChatRunError } from "../src/chat-service.js";
import { BACKGROUND_CONTEXT } from "../src/session-store.js";
import { leakyStore, startHarness } from "./helpers.js";

describe("ChatService under failure", () => {
  it("a recorded boundary violation survives the wait() itself failing (request cancelled mid-run)", async () => {
    const h = await startHarness({ store: leakyStore() });
    try {
      const token = await h.token({ tid: "tenant-a", sub: "alice" });
      const auth = await h.app.authenticate({ authorization: `Bearer ${token}` }, "req-cancel");
      if (!auth.ok) throw new Error("test setup: authentication failed");

      const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
      h.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo: "BK1001" }, { id: "call-1" }), { stopReason: "toolUse" }),
        // The second request carries the foreign tool result. Cancel the caller while it is in flight.
        async () => {
          cancel();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return fauxAssistantMessage(fauxText("late"));
        },
      ]);

      const failure = await h.app.chat.chat(auth.context, { message: "BK1001?" }, context).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(h.faux.state.callCount).toBe(2);
      expect(failure).toBeInstanceOf(ChatRunError);
      expect((failure as ChatRunError).code).toBe("output_scope_violation");
      expect((failure as ChatRunError).detail).toMatch(/provider-boundary recorded [1-9]\d* violation\(s\).*the run also failed/);
    } finally {
      await h.close();
    }
  });
});
