import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, type HarnessInspection, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { createBookingRegistry, openRootConversation } from "../src/create-harness.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { listEntries } from "../src/transcript.js";
import { createFauxModels, SpyBookingRepository, withTempSessionsRoot } from "./helpers.js";

/**
 * These tests drive the real `Harness` over real JSONL storage with a scripted model. A "process"
 * here is: open the storage, attach a brand-new Harness, do some work, close. Nothing is shared
 * between two calls to `runProcess` except the files on disk, which is exactly what a restart
 * leaves behind. No live model is called.
 */

const ctx = BACKGROUND_CONTEXT;

interface Attached {
  root: Conversation;
  inspection: HarnessInspection;
  created: boolean;
}

function toolCallThenAnswer(answer: string) {
  return [
    fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo: "BK1001" }, { id: "call-1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(answer),
  ];
}

function setup() {
  const { faux, models, selection } = createFauxModels();
  const repository = new SpyBookingRepository();

  async function runProcess<T>(sessionsRoot: string, sessionId: string, body: (attached: Attached) => Promise<T>) {
    const { storage, created } = await openSessionStorage(sessionsRoot, sessionId, ctx);
    const { harness, root, inspection } = await openRootConversation(
      storage,
      { models, selection, registry: createBookingRegistry(repository) },
      ctx,
    );
    try {
      return await body({ root, inspection, created });
    } finally {
      await harness.close(ctx);
    }
  }

  async function ask(root: Conversation, content: string) {
    return (await root.submit({ type: "input", content }, ctx)).wait(ctx);
  }

  return { faux, repository, runProcess, ask };
}

describe("durable Harness session over JSONL storage", () => {
  it("keeps the transcript across a close/reopen and answers a follow-up from it", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, repository, runProcess, ask } = setup();

      // ---- first process: a full tool-using turn, then a clean exit ----
      faux.setResponses(toolCallThenAnswer("Booking BK1001 uses containers MSKU1234567 and MSKU7654321."));
      const first = await runProcess(sessionsRoot, "conversation-a", async ({ root, inspection, created }) => {
        expect(created).toBe(true);
        expect(inspection.tasks).toEqual([]);
        expect(inspection.submissions).toEqual([]);

        const settled = await ask(root, "What are the details for booking BK1001?");
        expect(settled.status).toBe("done");
        return { rootId: root.id, settled, entries: await listEntries(root, ctx) };
      });

      expect(first.entries.map((entry) => entry.kind)).toEqual([
        "pi.user",
        "pi.system",
        "pi.assistant",
        "pi.tool-result",
        "pi.assistant",
      ]);
      expect(first.settled).toMatchObject({ answer: first.entries.at(-1)?.id });

      // ---- second process: same session id, nothing in memory carried over ----
      let requestRoles: string[] = [];
      let requestCarriesBothContainers = false;
      faux.setResponses([
        (context) => {
          requestRoles = context.messages.map((message) => message.role);
          const request = JSON.stringify(context.messages);
          requestCarriesBothContainers = request.includes("MSKU1234567") && request.includes("MSKU7654321");
          return fauxAssistantMessage("It uses MSKU1234567 and MSKU7654321.");
        },
      ]);

      await runProcess(sessionsRoot, "conversation-a", async ({ root, inspection, created }) => {
        expect(created).toBe(false);
        expect(root.id).toBe(first.rootId);
        expect(root.id).toBe(ROOT_CONVERSATION_ID);
        // Nothing was left half-done by the previous process, so there is nothing to resume.
        expect(inspection.scheduling).toBe("paused");
        expect(inspection.tasks).toEqual([]);
        expect(inspection.submissions).toEqual([]);

        // Reopening reads the same committed records back, record for record.
        expect(await listEntries(root, ctx)).toEqual(first.entries);

        const settled = await ask(root, "Which container is it using?");
        expect(settled.status).toBe("done");

        const after = await listEntries(root, ctx);
        expect(after).toHaveLength(first.entries.length + 2);
        expect(after.slice(0, first.entries.length)).toEqual(first.entries);
        expect(after.slice(first.entries.length).map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant"]);
        expect(new Set(after.map((entry) => entry.id)).size).toBe(after.length);
      });

      // The model's second request carried the first process's tool result, with both containers of
      // the booking, so the follow-up was answered from durable history rather than by calling the
      // tool again.
      expect(requestRoles).toEqual(["system", "user", "assistant", "toolResult", "assistant", "user"]);
      expect(requestCarriesBothContainers).toBe(true);
      expect(repository.lookups).toEqual(["BK1001"]);
      expect(faux.state.callCount).toBe(3);
    }));

  it("keeps a different session id isolated from another session's transcript", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, repository, runProcess, ask } = setup();

      faux.setResponses(toolCallThenAnswer("Booking BK1001 uses containers MSKU1234567 and MSKU7654321."));
      await runProcess(sessionsRoot, "conversation-a", ({ root }) => ask(root, "What are the details for booking BK1001?"));

      let requestRoles: string[] = [];
      let requestMentionsAnyContainer = true;
      faux.setResponses([
        (context) => {
          requestRoles = context.messages.map((message) => message.role);
          const request = JSON.stringify(context.messages);
          requestMentionsAnyContainer = request.includes("MSKU1234567") || request.includes("MSKU7654321");
          return fauxAssistantMessage("Which booking do you mean?");
        },
      ]);

      await runProcess(sessionsRoot, "conversation-b", async ({ root, inspection, created }) => {
        expect(created).toBe(true);
        expect(inspection.tasks).toEqual([]);
        expect(await listEntries(root, ctx)).toEqual([]);

        const settled = await ask(root, "Which container is it using?");
        expect(settled.status).toBe("done");
        expect((await listEntries(root, ctx)).map((entry) => entry.kind)).toEqual([
          "pi.user",
          "pi.system",
          "pi.assistant",
        ]);
      });

      expect(requestRoles).toEqual(["system", "user"]);
      expect(requestMentionsAnyContainer).toBe(false);
      expect(repository.lookups).toEqual(["BK1001"]);
    }));

  // `root()` applies its `agent` choices only when it creates the conversation. A later process that
  // starts with a different PI_MODEL still runs the session on the model stored at creation.
  it("keeps the model chosen at creation when the session is reopened with a different selection", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { models, selection: modelA } = createFauxModels(["model-A", "model-B"]);
      const modelB = { ...modelA, modelId: "model-B" };

      async function storedModel(selection: typeof modelA): Promise<string | undefined> {
        const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
        const { harness, root } = await openRootConversation(storage, { models, selection }, ctx);
        try {
          return (await root.agent(ctx)).model?.modelId;
        } finally {
          await harness.close(ctx);
        }
      }

      expect(await storedModel(modelA)).toBe("model-A");
      expect(await storedModel(modelB)).toBe("model-A");
    }));

  it("records a provider failure as an unanswered submission instead of throwing", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess, ask } = setup();
      faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 invalid api key" })]);

      await runProcess(sessionsRoot, "conversation-a", async ({ root }) => {
        const settled = await ask(root, "What are the details for booking BK1001?");
        expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: "401 invalid api key" });
      });
    }));
});
