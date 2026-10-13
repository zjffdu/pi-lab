import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { appendCaseNote } from "../src/case-note-entries.js";
import { CaseNoteRepository } from "../src/case-note-repository.js";
import { createBookingRegistry, openHarness } from "../src/create-harness.js";
import { attachTraceLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { createFauxModels, SpyBookingRepository, withTempSessionsRoot } from "./helpers.js";

const ctx = BACKGROUND_CONTEXT;

// Entry and submission ids are one shared counter, so they depend on how many records the harness wrote
// first. The trace shape is what these tests pin down, not the counter values.
function normalize(lines: string[]): string[] {
  return lines.map((line) => line.replace(/entry=\d+/g, "entry=N").replace(/inputs=\[\d+\]/g, "inputs=[N]"));
}

async function traceOneTurn(responses: ReturnType<typeof fauxAssistantMessage>[], prompt: string) {
  return withTempSessionsRoot(async (sessionsRoot) => {
    const { faux, models, selection } = createFauxModels();
    faux.setResponses(responses);

    const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
    const { harness, root } = await openHarness(
      storage,
      { models, selection, registry: createBookingRegistry({ bookings: new SpyBookingRepository() }) },
      ctx,
    );

    const lines: string[] = [];
    const trace = await attachTraceLogger(harness, root.id, (line) => lines.push(line), ctx);
    const settled = await (await root.submit({ type: "input", content: prompt }, ctx)).wait(ctx);
    await trace.settled(settled.id);
    await trace.stop();
    await harness.close(ctx);

    return { lines: normalize(lines), settled };
  });
}

describe("harness trace logger", () => {
  it("renders prompt -> tool call -> tool result -> answer as a run/turn tree, with the call's arguments", async () => {
    const { lines, settled } = await traceOneTurn(
      [
        fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo: "BK1001" }, { id: "call-1" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("final answer"),
      ],
      "What are the details for booking BK1001?",
    );

    expect(settled.status).toBe("done");
    expect(lines).toEqual([
      'user       "What are the details for booking BK1001?" entry=N',
      "▶ run inputs=[N]",
      "  ▶ turn #1",
      "    system     (prompt and tool changes) entry=N",
      '    assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"} entry=N',
      '    ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "    ◀ tool_end get_booking status=success",
      "    toolResult get_booking status=success entry=N",
      "  ◀ turn_end #1 tool_results=1",
      "  ▶ turn #2",
      "    [Assistant] entry=N final answer",
      "  ◀ turn_end #2 tool_results=0",
      "◀ run_end inputs=[N]",
    ]);
  });

  it("prints preamble text and every requested tool call as separate lines", async () => {
    const { lines, settled } = await traceOneTurn(
      [
        fauxAssistantMessage(
          [
            fauxText("Let me check both bookings."),
            fauxToolCall("get_booking", { bookingNo: "BK1001" }, { id: "call-1" }),
            fauxToolCall("get_booking", { bookingNo: "BAD_ID" }, { id: "call-2" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ],
      "Compare BK1001 and BAD_ID.",
    );

    expect(settled.status).toBe("done");
    const turnOne = lines.slice(lines.indexOf("  ▶ turn #1"), lines.indexOf("  ◀ turn_end #1 tool_results=2") + 1);
    expect(turnOne).toEqual([
      "  ▶ turn #1",
      "    system     (prompt and tool changes) entry=N",
      "    [Assistant] entry=N Let me check both bookings.",
      '    assistant (tool call) get_booking call=call-1 args={"bookingNo":"BK1001"} entry=N',
      '    assistant (tool call) get_booking call=call-2 args={"bookingNo":"BAD_ID"} entry=N',
      '    ▶ tool_start get_booking call=call-1 args={"bookingNo":"BK1001"}',
      "    ◀ tool_end get_booking status=success",
      "    toolResult get_booking status=success entry=N",
      '    ▶ tool_start get_booking call=call-2 args={"bookingNo":"BAD_ID"}',
      "    ◀ tool_end get_booking status=error",
      "    toolResult get_booking status=error entry=N",
      "  ◀ turn_end #1 tool_results=2",
    ]);
  });

  it("shows a provider failure on the assistant line", async () => {
    const { lines, settled } = await traceOneTurn(
      [fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 invalid api key" })],
      "What are the details for booking BK1001?",
    );

    expect(settled.status).toBe("unanswered");
    expect(lines).toContain("    assistant (error) 401 invalid api key entry=N");
  });

  it("writes a visible warning instead of hanging when a submission never settles", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { models, selection } = createFauxModels();
      const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
      const { harness, root } = await openHarness(storage, { models, selection }, ctx);

      const lines: string[] = [];
      const trace = await attachTraceLogger(harness, root.id, (line) => lines.push(line), ctx);
      await trace.settled(999 as unknown as SubmissionId, 20);
      await trace.stop();
      await harness.close(ctx);

      expect(lines).toEqual(["trace: no settle event for submission 999 within 20ms"]);
    }));
});

describe("harness trace logger with case notes", () => {
  const [shared, internal] = CaseNoteRepository.fromDefaultFixture().findByBookingNo("BK1001");

  async function traceNotes() {
    return withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, models, selection } = createFauxModels();
      faux.setResponses([fauxAssistantMessage("ok")]);
      const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
      const { harness, root } = await openHarness(storage, { models, selection }, ctx);

      const lines: string[] = [];
      const trace = await attachTraceLogger(harness, root.id, (line) => lines.push(line), ctx);
      await appendCaseNote(root, shared!, "durable-only", ctx);
      await appendCaseNote(root, shared!, "projected", ctx);
      await appendCaseNote(root, internal!, "projected", ctx);
      const settled = await (await root.submit({ type: "input", content: "Any news?" }, ctx)).wait(ctx);
      await trace.settled(settled.id);
      await trace.stop();
      await harness.close(ctx);
      return normalize(lines);
    });
  }

  it("renders a note as its id, visibility, and whether it carries a model message — in write order", async () => {
    expect(await traceNotes()).toEqual([
      "case_note CN-001 visibility=shared durable-only (no model message) entry=N",
      "case_note CN-001 visibility=shared projects 1 model message entry=N",
      "case_note CN-002 visibility=internal durable-only (no model message) entry=N",
      'user       "Any news?" entry=N',
      "▶ run inputs=[N]",
      "  ▶ turn #1",
      "    system     (prompt and tool changes) entry=N",
      "    [Assistant] entry=N ok",
      "  ◀ turn_end #1 tool_results=0",
      "◀ run_end inputs=[N]",
    ]);
  });

  // The stream's own `message_end` / `entry_appended` events carry the whole record, so a logger that
  // printed events or entries wholesale would put the secret in the log. This pins that it does not.
  it("never prints a note's text or its internalOnly value, for any note", async () => {
    const trace = (await traceNotes()).join("\n");
    for (const note of [shared!, internal!]) {
      expect(trace).not.toContain(note.text);
      expect(trace).not.toContain(note.internalOnly!);
    }
  });
});
