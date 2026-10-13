import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, GenerationTask, Harness, hook } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { createBookingRegistry, openHarness } from "../src/create-harness.js";
import { createProviderBoundary, type RequestSummary } from "../src/provider-boundary.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { answerAndRecord, createFauxModels, withTempSessionsRoot } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;

async function open(sessionsRoot: string, faux: ReturnType<typeof createFauxModels>, onRequest?: (r: RequestSummary) => void) {
  const boundary = createProviderBoundary(onRequest ? { onRequest } : {});
  const { storage } = await openSessionStorage(sessionsRoot, "boundary", ctx);
  const opened = await openHarness(
    storage,
    { models: faux.models, selection: faux.selection, registry: createBookingRegistry({ boundary }) },
    ctx,
  );
  return { ...opened, boundary };
}

describe("provider boundary", () => {
  it("ignores empty and duplicate forbidden texts", () => {
    const boundary = createProviderBoundary();
    boundary.forbid("", "SECRET-A", "SECRET-A", "SECRET-B");
    expect(boundary.forbiddenCount).toBe(2);
  });

  it("reports each request by count and roles only, and leaves the request exactly as built", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const faux = createFauxModels();
      const seen: Message[][] = [];
      faux.faux.setResponses([answerAndRecord("hello", seen)]);
      const summaries: RequestSummary[] = [];
      const { harness, root, boundary } = await open(sessionsRoot, faux, (summary) => summaries.push(summary));
      boundary.forbid("SECRET-NEVER-PRESENT");

      await (await root.submit({ type: "input", content: "Hi there" }, ctx)).wait(ctx);

      expect(summaries).toEqual([{ index: 1, messageCount: 2, roles: ["system", "user"] }]);
      expect(boundary.requests).toEqual(summaries);
      expect(boundary.violations).toEqual([]);
      expect(seen[0]!.map((message) => message.role)).toEqual(["system", "user"]);

      await harness.close(ctx);
    }));

  // The model's own tool-call arguments and the tool's error text travel back to the provider on the next
  // request, so a forbidden text that gets there by that route is a violation too, not only one in a user message.
  it("also finds a forbidden text carried in a tool call's arguments or its result", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const faux = createFauxModels();
      faux.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo: "SECRET-IN-ARGS" }, { id: "call-1" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ]);
      const { harness, root, boundary } = await open(sessionsRoot, faux);
      boundary.forbid("SECRET-IN-ARGS");

      await (await root.submit({ type: "input", content: "Look something up." }, ctx)).wait(ctx);

      // Request 1 is clean. Request 2 carries the assistant's tool call and the tool's error result.
      expect(boundary.requests).toHaveLength(2);
      expect(boundary.violations.map((violation) => ({ request: violation.request, role: violation.role }))).toEqual([
        { request: 2, role: "assistant" },
        { request: 2, role: "toolResult" },
      ]);

      await harness.close(ctx);
    }));

  // Pins the Pi 1.1 behavior the design rests on: a `beforeRequest` hook cannot stop a request by throwing.
  // The throw is reported through `HarnessOptions.onReport` and the request is sent anyway, which is why
  // the guard records violations and the lab never calls it a barrier.
  it("cannot block a request by throwing: Pi reports the error and still sends the request", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, models, selection } = createFauxModels();
      const sent: Message[][] = [];
      faux.setResponses([answerAndRecord("answered anyway", sent)]);

      const registry = createRegistry();
      registry.install(
        defineExtension({
          name: "thrower",
          hooks: [
            hook(GenerationTask, {
              beforeRequest: () => {
                throw new Error("guard says no");
              },
            }),
          ],
        }),
      );
      const reports: string[] = [];
      const { storage } = await openSessionStorage(sessionsRoot, "boundary-throw", ctx);
      const harness = await Harness.open(storage, { models, registry, onReport: (error) => reports.push(String(error)) }, ctx);
      const root = await harness.root(ctx, { agent: { model: { provider: selection.provider, modelId: selection.modelId } } });

      const settled = await (await root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);

      expect(settled.status).toBe("done");
      expect(sent).toHaveLength(1);
      expect(reports).toEqual(["Error: guard says no"]);

      await harness.close(ctx);
    }));
});
