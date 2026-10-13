import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { CompactionPolicy, Conversation, Harness } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import {
  compactConversation,
  compactionEntries,
  compactionSummaryText,
  estimatedContextTokens,
  extractShipmentIdentifiers,
  keepRecentTokensForLastTurns,
} from "../src/compaction.js";
import { createBookingRegistry, openRootConversation } from "../src/create-harness.js";
import { attachTraceLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { listEntries } from "../src/transcript.js";
import { createFauxModels, withTempSessionsRoot } from "./helpers.js";

/**
 * Everything here runs the real `Harness` over real JSONL storage with a scripted model, including
 * the summarization request a compaction makes — it is just the next queued faux response. No live
 * model is called, so the whole compaction path (cut selection, summary request, placement, reopen)
 * is proven deterministically; only the *quality* of a real model's summary needs a live run.
 */

const ctx = BACKGROUND_CONTEXT;
const SUMMARY = "SUMMARY: BK1001 CNSHA to NLRTM, MSKU1234567, no hold. BK1002 SGSIN to USLAX, hold = missing phytosanitary certificate.";
const OFF: Partial<CompactionPolicy> = { enabled: false, backgroundTokens: 0, reserveTokens: 300, keepRecentTokens: 180 };

type Faux = ReturnType<typeof createFauxModels>["faux"];

function setup() {
  const { faux, models, selection } = createFauxModels();
  const compaction: Partial<CompactionPolicy> = { ...OFF };

  async function runProcess<T>(
    sessionsRoot: string,
    body: (attached: { harness: Harness; root: Conversation }) => Promise<T>,
  ): Promise<T> {
    const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
    const { harness, root } = await openRootConversation(
      storage,
      { models, selection, registry: createBookingRegistry(), compaction },
      ctx,
    );
    try {
      return await body({ harness, root });
    } finally {
      await harness.close(ctx);
    }
  }

  return { faux, compaction, runProcess };
}

async function turn(faux: Faux, root: Conversation, prompt: string, replies: Parameters<Faux["setResponses"]>[0]) {
  faux.setResponses(replies);
  const settled = await (await root.submit({ type: "input", content: prompt }, ctx)).wait(ctx);
  expect(settled.status).toBe("done");
}

function lookup(tool: string, args: Record<string, string>, id: string, answer: string) {
  return [
    fauxAssistantMessage(fauxToolCall(tool, args, { id }), { stopReason: "toolUse" }),
    fauxAssistantMessage(answer),
  ];
}

/** Six turns; turn 2 is the only place BK1002's hold enters the transcript (as a tool result). */
async function seedSixTurns(faux: Faux, root: Conversation, onFirstRequest?: (roles: string[]) => void) {
  const first = lookup("get_booking", { bookingNo: "BK1001" }, "c1", "BK1001: CNSHA to NLRTM, container MSKU1234567, no hold.");
  await turn(
    faux,
    root,
    "Look up booking BK1001.",
    onFirstRequest
      ? [
          (context) => {
            onFirstRequest(context.messages.map((message) => message.role));
            return first[0] as ReturnType<typeof fauxAssistantMessage>;
          },
          first[1]!,
        ]
      : first,
  );
  await turn(faux, root, "Now look up BK1002; flag anything unusual.", lookup("get_booking", { bookingNo: "BK1002" }, "c2", "BK1002: SGSIN to USLAX. Unusual: customs hold, missing phytosanitary certificate."));
  // BK1001 has two containers: one assistant message requests both, so this turn holds two tool results.
  await turn(faux, root, "Events for every container of BK1001?", [
    fauxAssistantMessage(
      [
        fauxToolCall("get_container_events", { containerNo: "MSKU1234567" }, { id: "c3a" }),
        fauxToolCall("get_container_events", { containerNo: "MSKU2345678" }, { id: "c3b" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("MSKU1234567 and MSKU2345678: GATE_IN, LOAD, DEPARTURE, all at CNSHA."),
  ]);
  await turn(faux, root, "Which is more time-sensitive?", [fauxAssistantMessage("BK1002, because of its open hold and shorter transit.")]);
  await turn(faux, root, "One sentence: origin of BK1001?", [fauxAssistantMessage("CNSHA.")]);
  await turn(faux, root, "One sentence: vessel of BK1002?", [fauxAssistantMessage("MAERSK SECOND.")]);
}

/** Plain text of every message in a request, so substring assertions see the real characters
 * (a `JSON.stringify` of the messages would escape the quotes inside a tool result). */
function plainText(messages: readonly { role: string; content?: unknown }[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content
        .map((block: { type?: string; text?: string; name?: string; arguments?: unknown }) =>
          block.type === "toolCall" ? `${block.name}(${JSON.stringify(block.arguments)})` : (block.text ?? ""),
        )
        .join("");
    })
    .join("\n");
}

function requestSnapshot(captured: { roles: string[]; text: string }[]) {
  return (context: { messages: readonly { role: string; content?: unknown }[] }) => {
    captured.push({ roles: context.messages.map((message) => message.role), text: plainText(context.messages) });
  };
}

describe("compaction on a durable Conversation (pi-durable 1.1)", () => {
  it("adds one pi.compaction entry, keeps every older entry, and shrinks the next request", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, compaction, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ harness, root }) => {
        await seedSixTurns(faux, root);

        const entriesBefore = await listEntries(root, ctx);
        const viewBefore = await root.context(ctx);
        expect(viewBefore.head).toBeUndefined();
        expect(entriesBefore.map((entry) => entry.kind)).toContain("pi.tool-result");

        // The harness reads its settings object on every resolution, so mutating it after the
        // transcript exists takes effect without reopening the session.
        compaction.keepRecentTokens = keepRecentTokensForLastTurns(viewBefore, 3);

        const summarizerRequests: { roles: string[]; text: string }[] = [];
        const capture = requestSnapshot(summarizerRequests);
        faux.setResponses([
          (context) => {
            capture(context);
            return fauxAssistantMessage(SUMMARY);
          },
        ]);
        const instructions = "Preserve every booking identifier and any customs hold.";
        const outcome = await compactConversation(harness, root, instructions, ctx);
        expect(outcome.kind).toBe("placed");

        // ---- durable history: purely additive ----
        const entriesAfter = await listEntries(root, ctx);
        expect(entriesAfter).toHaveLength(entriesBefore.length + 1);
        expect(entriesAfter.slice(0, entriesBefore.length)).toEqual(entriesBefore);

        const [compactionEntry] = compactionEntries(entriesAfter);
        expect(entriesAfter.at(-1)).toEqual(compactionEntry);
        expect(compactionEntry).toMatchObject({ kind: "pi.compaction", data: { reason: "manual" } });
        expect(compactionSummaryText(compactionEntry!)).toContain(SUMMARY);
        if (outcome.kind === "placed") {
          expect(compactionEntry!.id).toBe(outcome.entryId);
        }

        // ---- the cut: `head` is the first entry kept verbatim — the user message of turn 4 ----
        const turn4 = entriesBefore.filter((entry) => entry.kind === "pi.user")[3]!;
        expect(compactionEntry!.head).toBe(turn4.id);

        // ---- model context: summary first, then exactly the last three turns ----
        const viewAfter = await root.context(ctx);
        expect(viewAfter.head?.id).toBe(compactionEntry!.id);
        expect(viewAfter.messages.map((message) => message.role)).toEqual([
          "user", // the summary
          "user", "assistant", // turn 4
          "user", "assistant", // turn 5
          "user", "assistant", // turn 6
        ]);
        expect(JSON.stringify(viewAfter.messages[0])).toContain(SUMMARY);
        expect(estimatedContextTokens(viewAfter)).toBeLessThan(estimatedContextTokens(viewBefore));

        // ---- the summarizer saw the early history and the custom instructions ----
        expect(summarizerRequests).toHaveLength(1);
        expect(summarizerRequests[0]!.text).toContain('"bookingNo":"BK1002"'); // the raw early tool result, serialized for the summarizer
        expect(summarizerRequests[0]!.text).toContain("missing phytosanitary certificate");
        expect(summarizerRequests[0]!.text).toContain(instructions);

        // ---- the pre-compaction view can still be rebuilt from durable entries ----
        const lastBefore = entriesBefore.at(-1)!;
        const rebuilt = await root.context(ctx, { at: lastBefore.id });
        expect(rebuilt.messages).toEqual(viewBefore.messages);
        expect(rebuilt.head).toBeUndefined();

        // ---- the next real request: summary + tail, early tool result gone ----
        const followUps: { roles: string[]; text: string }[] = [];
        const captureFollowUp = requestSnapshot(followUps);
        faux.setResponses([
          (context) => {
            captureFollowUp(context);
            return fauxAssistantMessage("BK1002: missing phytosanitary certificate.");
          },
        ]);
        const settled = await (await root.submit({ type: "input", content: "Which booking had a flag?" }, ctx)).wait(ctx);
        expect(settled.status).toBe("done");

        const request = followUps[0]!;
        expect(request.text).toContain(SUMMARY); // the summary is in the request
        expect(request.text).toContain("MAERSK SECOND."); // the retained tail is verbatim
        expect(request.text).not.toContain('"bookingNo":"BK1002"'); // the raw early tool result is not
        expect(request.roles.filter((role) => role === "toolResult")).toEqual([]);
      });
    }));

  it("survives a process restart: the reopened session rebuilds the same compacted context", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, compaction, runProcess } = setup();

      const first = await runProcess(sessionsRoot, async ({ harness, root }) => {
        await seedSixTurns(faux, root);
        compaction.keepRecentTokens = keepRecentTokensForLastTurns(await root.context(ctx), 3);
        faux.setResponses([fauxAssistantMessage(SUMMARY)]);
        expect((await compactConversation(harness, root, undefined, ctx)).kind).toBe("placed");
        return { entries: await listEntries(root, ctx), view: await root.context(ctx) };
      });

      await runProcess(sessionsRoot, async ({ root }) => {
        expect(await listEntries(root, ctx)).toEqual(first.entries);
        const view = await root.context(ctx);
        expect(view.head).toEqual(first.view.head);
        expect(view.messages).toEqual(first.view.messages);
      });
    }));

  it("reports nothing_to_compact, and writes nothing, when there is no old prefix to cut", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, compaction, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ harness, root }) => {
        await seedSixTurns(faux, root);
        const before = await listEntries(root, ctx);

        // A budget larger than the whole transcript keeps everything "recent".
        compaction.keepRecentTokens = 20_000;
        const outcome = await compactConversation(harness, root, undefined, ctx);

        expect(outcome.kind).toBe("nothing_to_compact");
        expect(await listEntries(root, ctx)).toEqual(before);
      });
    }));

  // pi-durable's CHANGELOG [1.1.0] "Fixed" says the baseline after a compaction "now leads the model
  // context instead of following the input that started the run". This test pins what 1.1.0 actually
  // sends, so a later pin that fixes (or changes) it fails here instead of silently differing from
  // the README.
  it("records where the system baseline lands in the request after a compaction", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, compaction, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ harness, root }) => {
        let firstRequestRoles: string[] = [];
        await seedSixTurns(faux, root, (roles) => {
          firstRequestRoles = roles;
        });
        compaction.keepRecentTokens = keepRecentTokensForLastTurns(await root.context(ctx), 3);
        faux.setResponses([fauxAssistantMessage(SUMMARY)]);
        expect((await compactConversation(harness, root, undefined, ctx)).kind).toBe("placed");

        let followUpRoles: string[] = [];
        faux.setResponses([
          (context) => {
            followUpRoles = context.messages.map((message) => message.role);
            return fauxAssistantMessage("ok");
          },
        ]);
        await (await root.submit({ type: "input", content: "Which booking had a flag?" }, ctx)).wait(ctx);

        // Before any compaction the system message leads, as in Lab 07 ...
        expect(firstRequestRoles).toEqual(["system", "user"]);
        // ... after compaction the re-established baseline follows the newest user input instead.
        expect(followUpRoles.indexOf("system")).toBe(followUpRoles.length - 1);
        expect(followUpRoles.filter((role) => role === "system")).toHaveLength(1);
        expect((await listEntries(root, ctx)).slice(-4).map((entry) => entry.kind)).toEqual([
          "pi.compaction",
          "pi.user",
          "pi.system",
          "pi.assistant",
        ]);
      });
    }));

  it("fails the compaction task, and writes nothing, when the summary hits its token limit", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, compaction, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ harness, root }) => {
        await seedSixTurns(faux, root);
        compaction.keepRecentTokens = keepRecentTokensForLastTurns(await root.context(ctx), 3);
        const before = await listEntries(root, ctx);

        // A summary that stops because it ran out of tokens is incomplete; 1.1 does not keep it.
        faux.setResponses([fauxAssistantMessage("SUMMARY: BK1001 CNSHA to", { stopReason: "length" })]);
        const outcome = await compactConversation(harness, root, undefined, ctx);

        expect(outcome.kind).toBe("task_failed");
        expect(outcome.kind === "task_failed" ? outcome.detail : "").toContain("token limit");
        expect(await listEntries(root, ctx)).toEqual(before);
      });
    }));

  it("can cut inside a turn: a budget that crosses an assistant entry orphans its answer from its question", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, compaction, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ harness, root }) => {
        await seedSixTurns(faux, root);
        const viewBefore = await root.context(ctx);

        // Keep everything from turn 2's *final assistant answer* onward. `selectCut` stops on that
        // entry; assistant messages are valid cut candidates, so the cut does not move to a user message.
        const turn2Answer = viewBefore.entries.findIndex((entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("Unusual:"));
        expect(turn2Answer).toBeGreaterThan(0);
        compaction.keepRecentTokens = viewBefore.contributions
          .slice(turn2Answer)
          .flat()
          .reduce((total, message) => total + estimateMessageTokens(message), 0);

        faux.setResponses([fauxAssistantMessage(SUMMARY)]);
        expect((await compactConversation(harness, root, undefined, ctx)).kind).toBe("placed");

        const [compactionEntry] = compactionEntries(await listEntries(root, ctx));
        expect(compactionEntry!.head).toBe(viewBefore.entries[turn2Answer]!.id);
        expect(viewBefore.entries[turn2Answer]!.kind).toBe("pi.assistant");

        const viewAfter = await root.context(ctx);
        // summary, then an assistant message with no user message before it
        expect(viewAfter.messages.slice(0, 2).map((message) => message.role)).toEqual(["user", "assistant"]);
      });
    }));

  it("renders compaction_start and compaction_end in the trace", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, compaction, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ harness, root }) => {
        await seedSixTurns(faux, root);
        compaction.keepRecentTokens = keepRecentTokensForLastTurns(await root.context(ctx), 3);

        const lines: string[] = [];
        const trace = await attachTraceLogger(harness, root.id, (line) => lines.push(line), ctx);
        faux.setResponses([fauxAssistantMessage(SUMMARY)]);
        expect((await compactConversation(harness, root, undefined, ctx)).kind).toBe("placed");

        // `stop()` does not flush pending frames, so wait for the terminal line to arrive.
        const deadline = Date.now() + 2000;
        while (!lines.some((line) => line.includes("compaction_end")) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await trace.stop();

        expect(lines.some((line) => line.includes("▶ compaction_start") && line.includes("reason=manual"))).toBe(true);
        expect(lines.some((line) => line.includes("◀ compaction_end") && line.includes("reason=manual"))).toBe(true);
      });
    }));
});

describe("extractShipmentIdentifiers", () => {
  it("finds booking and container numbers once each, sorted, and ignores look-alikes", () => {
    expect(
      extractShipmentIdentifiers("BK1002 uses MSKU7654321; BK1001 / MSKU1234567; BK1002 again; BK12345 and ABC1234567X are not ids"),
    ).toEqual(["BK1001", "BK1002", "MSKU1234567", "MSKU7654321"]);
  });
});
