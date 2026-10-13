import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { CompactionTask, createRegistry, defineExtension, GenerationTask, Harness, hook } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SUMMARY_PREFIX } from "../src/provider-boundary.js";
import { listEntries } from "../src/transcript.js";
import { BASELINE_OPERATOR_TOOLS, BASELINE_READER_TOOLS, callThenAnswer, offeredToolsOf, say, SMALL_COMPACTION, startHarness, toolCall, type Harness as TestHarness } from "./helpers.js";

/**
 * Behaviors of Pi 1.1.0 (`pi-durable`) this lab's design depends on. If one of these fails after an SDK
 * upgrade, the corresponding control in the lab needs to be re-derived, not just the test updated.
 */
describe("Pi behaviors the design depends on (through the service)", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("persists a tool result's `details` (the provenance record) in the durable session", async () => {
    h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "See [KB-100@2]."));
    expect((await h.as("tenant-a", "carol").chat("procedure?")).status).toBe(200);
    expect(await h.sessionFilesText()).toContain('"sources":[{"sourceId":"KB-100","version":2}');
  });

  it("a request has no `tools` field: the offer travels on system messages, so the offer is read by folding them", async () => {
    h.script([say("ok")]);
    await h.as("tenant-a", "alice").chat("hello");
    expect(offeredToolsOf(h.providerMessages[0] as never)).toEqual(BASELINE_OPERATOR_TOOLS);
    // The positive control: a viewer's offer is *different*, so an assertion that a tool is absent cannot pass vacuously.
    h.script([say("ok")]);
    await h.as("tenant-a", "carol").chat("hello");
    expect(offeredToolsOf(h.providerMessages[1] as never)).toEqual(BASELINE_READER_TOOLS);
    expect(offeredToolsOf(h.providerMessages[1] as never)).not.toEqual(offeredToolsOf(h.providerMessages[0] as never));
  });

  it("refuses a tool the conversation does not offer, as a tool_unavailable result, and the run continues", async () => {
    h.script([toolCall("cancel_all_bookings", {}, "c1"), say("done")]);
    const res = await h.as("tenant-a", "alice").chat("cancel everything");
    expect(res.status).toBe(200);
    expect(h.traceLines.join("\n")).toMatch(/⊘ tool_refused cancel_all_bookings call=c1 code=tool_unavailable/);
    expect(h.traceLines.join("\n")).not.toContain("▶ tool_start cancel_all_bookings");
  });

  it("refuses arguments outside the schema (additionalProperties: false) before the tool starts, so no extra field reaches execute()", async () => {
    h.script(callThenAnswer("propose_booking_status_change", { bookingNo: "BK1001", newStatus: "on_hold", reason: "r", tenantId: "tenant-b", requester: "bob", state: "approved" }, "done"));
    const res = await h.as("tenant-a", "alice").chat("propose");
    expect(res.status).toBe(200);
    expect(h.app.ledger.proposals).toEqual([]);
    expect(h.traceLines.join("\n")).toMatch(/⊘ tool_refused propose_booking_status_change call=call-1 code=invalid_arguments/);
  });

  it("a healthy run swallows no hook failure", async () => {
    h.script(callThenAnswer("search_documents", { query: "procedure broker clearance" }, "ok [KB-100@2]"));
    await h.as("tenant-a", "carol").chat("procedure?");
    expect(h.reports).toEqual([]);
  });
});

/** A bare `Harness` with two logging hooks, so each test can see which hooks a given path runs. */
async function bare(options: { enabled: boolean; contextWindow?: number; beforeRequest?: () => void; decline?: boolean }) {
  const faux = fauxProvider({ models: [{ id: "f", contextWindow: options.contextWindow ?? 100000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const log: string[] = [];
  const reports: unknown[] = [];
  const extension = defineExtension({
    name: "probe",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: () => {
          log.push("beforeRequest");
          options.beforeRequest?.();
          return undefined;
        },
      }),
      hook(CompactionTask, {
        beforeCompact: (compaction) => {
          log.push(`beforeCompact:${compaction.reason}`);
          return options.decline ? { decline: true as const } : undefined;
        },
      }),
    ],
  });
  const registry = createRegistry();
  registry.install(extension);
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-19-sdk-"));
  const storage = await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT);
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { compaction: { ...SMALL_COMPACTION, enabled: options.enabled } }, onReport: (error) => reports.push(error) },
    BACKGROUND_CONTEXT,
  );
  const model = faux.getModel();
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const long = "padding ".repeat(200);
  const turn = async (text: string) => (await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  const script = (messages: Array<ReturnType<typeof fauxAssistantMessage>>) =>
    faux.setResponses(
      messages.map((message) => (context: { messages: unknown[] }) => {
        log.push(`provider(${context.messages.length})`);
        return message;
      }),
    );
  return { faux, harness, root, log, reports, long, turn, script, dir, close: async () => { await harness.close(BACKGROUND_CONTEXT); await rm(dir, { recursive: true, force: true }); } };
}

describe("hooks: a throw is not a block", () => {
  it("a throw in beforeRequest is reported and the request is sent anyway", async () => {
    const b = await bare({ enabled: false, beforeRequest: () => { throw new Error("boom"); } });
    try {
      b.script([fauxAssistantMessage("answer")]);
      const result = await b.turn("hello");
      expect(result.status).toBe("done");
      expect(b.log).toContain("provider(1)");
      expect(b.reports.map(String).join(" ")).toMatch(/boom/);
    } finally {
      await b.close();
    }
  });
});

describe("compaction: where a gate can and cannot stand", () => {
  const seed = async (b: Awaited<ReturnType<typeof bare>>) => {
    for (const text of ["q1", `q2 ${b.long}`, `q3 ${b.long}`]) await b.turn(text);
  };
  const base = (b: Awaited<ReturnType<typeof bare>>) => [fauxAssistantMessage(`a ${b.long}`), fauxAssistantMessage(`b ${b.long}`), fauxAssistantMessage(`c ${b.long}`)];

  it("a summarization request does not pass through beforeRequest — beforeCompact is the only hook in front of it", async () => {
    const b = await bare({ enabled: false });
    try {
      b.script([...base(b), fauxAssistantMessage("SUMMARY"), fauxAssistantMessage("after")]);
      await seed(b);
      b.log.length = 0;
      await b.harness.waitForTask(await b.root.compact("keep facts", BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
      expect(b.log[0]).toBe("beforeCompact:manual");
      expect(b.log.filter((line) => line.startsWith("provider"))).toHaveLength(1);
      expect(b.log).not.toContain("beforeRequest");
    } finally {
      await b.close();
    }
  });

  it("beforeCompact can decline a manual compaction: nothing is summarized and no summary entry exists", async () => {
    const b = await bare({ enabled: false, decline: true });
    try {
      b.script([...base(b), fauxAssistantMessage("SUMMARY")]);
      await seed(b);
      b.log.length = 0;
      await b.harness.waitForTask(await b.root.compact("x", BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
      expect(b.log).toEqual(["beforeCompact:manual"]);
      expect((await listEntries(b.root, BACKGROUND_CONTEXT)).map((entry) => entry.kind)).not.toContain("pi.compaction");
    } finally {
      await b.close();
    }
  });

  it("an automatic threshold compaction goes through beforeCompact and can be declined", async () => {
    for (const decline of [false, true]) {
      const b = await bare({ enabled: true, contextWindow: 1500, decline });
      try {
        b.script([...base(b), fauxAssistantMessage("SUMMARY"), fauxAssistantMessage("x"), fauxAssistantMessage("y")]);
        await seed(b);
        expect(b.log).toContain("beforeCompact:threshold");
        const kinds = (await listEntries(b.root, BACKGROUND_CONTEXT)).map((entry) => entry.kind);
        expect(kinds.includes("pi.compaction")).toBe(!decline);
      } finally {
        await b.close();
      }
    }
  });

  const overflow = fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 999999 tokens > 1000 maximum" });

  it("an overflow-recovery compaction goes through beforeCompact too (enabled), and declining leaves the run unanswered", async () => {
    for (const decline of [false, true]) {
      const b = await bare({ enabled: true, decline });
      try {
        b.script([...base(b), overflow, fauxAssistantMessage("SUMMARY"), fauxAssistantMessage("final")]);
        await seed(b);
        const result = await b.turn("q4");
        expect(b.log).toContain("beforeCompact:overflow");
        expect(result.status).toBe(decline ? "unanswered" : "done");
      } finally {
        await b.close();
      }
    }
  });

  it("with automatic compaction disabled, an overflow is not recovered by compacting (the run is unanswered, no hook runs)", async () => {
    const b = await bare({ enabled: false });
    try {
      b.script([...base(b), overflow]);
      await seed(b);
      const result = await b.turn("q4");
      expect(result.status).toBe("unanswered");
      expect(b.log.filter((line) => line.startsWith("beforeCompact"))).toEqual([]);
    } finally {
      await b.close();
    }
  });

  it("a summary reaches the next request as a user message that starts with SUMMARY_PREFIX (the text the guard demotes)", async () => {
    const b = await bare({ enabled: false });
    try {
      const seen: unknown[][] = [];
      b.faux.setResponses([
        ...base(b).map((message) => () => message),
        () => fauxAssistantMessage("A SUMMARY"),
        (context: { messages: unknown[] }) => {
          seen.push(context.messages);
          return fauxAssistantMessage("after");
        },
      ]);
      await seed(b);
      await b.harness.waitForTask(await b.root.compact("x", BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
      await b.turn("q4");
      const first = seen[0]?.[0] as { role: string; content: Array<{ text: string }> };
      expect(first.role).toBe("user");
      expect(first.content[0]?.text.startsWith(SUMMARY_PREFIX)).toBe(true);
    } finally {
      await b.close();
    }
  });
});

describe("entries Pi 1.1 stores, as this lab reads them", () => {
  it("a compaction entry holds its summary in a user-role message, so only the entry kind says it is derived", async () => {
    const b = await bare({ enabled: false });
    try {
      b.script([fauxAssistantMessage(`a ${b.long}`), fauxAssistantMessage(`b ${b.long}`), fauxAssistantMessage(`c ${b.long}`), fauxAssistantMessage("SUMMARY")]);
      for (const text of ["q1", `q2 ${b.long}`, `q3 ${b.long}`]) await b.turn(text);
      await b.harness.waitForTask(await b.root.compact("x", BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
      const compaction = (await listEntries(b.root, BACKGROUND_CONTEXT)).find((entry) => entry.kind === "pi.compaction");
      expect(compaction?.model?.[0]?.role).toBe("user");
    } finally {
      await b.close();
    }
  });
});
