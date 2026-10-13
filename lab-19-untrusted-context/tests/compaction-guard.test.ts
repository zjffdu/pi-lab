import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { afterEach, describe, expect, it } from "vitest";

import type { BranchAssessment } from "../src/context-provenance.js";
import { createEgressGuard, type BoundaryViolation } from "../src/provider-boundary.js";
import { listEntries } from "../src/transcript.js";
import { SMALL_COMPACTION } from "./helpers.js";

const clean: BranchAssessment = { verdict: "clean", refs: [], revoked: [], unattributable: [], contaminated: [], taintedEntryIds: new Set() };
const long = "padding ".repeat(200);

/** A real conversation with the real guard installed, and a scripted summarizer. Returns what the summarizer was sent. */
async function run(guard: { assess: () => Promise<BranchAssessment | undefined>; forbidden?: Array<{ label: string; value: string }>; marker?: string }) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const violations: BoundaryViolation[] = [];
  const summarizerSaw: string[] = [];
  const registry = createRegistry();
  registry.install(
    createEgressGuard({
      forbidden: () => guard.forbidden ?? [],
      canReadRef: () => true,
      assessConversation: guard.assess,
      onViolation: (violation) => violations.push(violation),
    }),
  );
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-19-guard-"));
  const harness = await Harness.open(await openNodeJsonlStorage(dir, BACKGROUND_CONTEXT), { models, registry, settings: { compaction: SMALL_COMPACTION } }, BACKGROUND_CONTEXT);
  const model = faux.getModel();
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const turns = ["q1", `q2 ${long} ${guard.marker ?? ""}`, `q3 ${long}`];
  faux.setResponses([
    ...turns.map(() => () => fauxAssistantMessage(`answer ${long}`)),
    (context: { messages: unknown[] }) => {
      summarizerSaw.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("SUMMARY");
    },
  ]);
  for (const text of turns) await (await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  await harness.waitForTask(await root.compact("x", BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
  const kinds = (await listEntries(root, BACKGROUND_CONTEXT)).map((entry) => entry.kind);
  await harness.close(BACKGROUND_CONTEXT);
  await rm(dir, { recursive: true, force: true });
  return { violations, summarizerSaw, compacted: kinds.includes("pi.compaction") };
}

describe("the compaction gate (beforeCompact)", () => {
  it("lets a clean conversation be summarized, with no violation recorded", async () => {
    const result = await run({ assess: async () => clean });
    expect(result.compacted).toBe(true);
    expect(result.summarizerSaw).toHaveLength(1);
    expect(result.violations).toEqual([]);
  });

  for (const verdict of ["revoked", "unattributable", "contaminated"] as const) {
    it(`declines when the conversation is ${verdict}: the summarizer is never called`, async () => {
      const result = await run({ assess: async () => ({ ...clean, verdict }) });
      expect(result.compacted).toBe(false);
      expect(result.summarizerSaw).toEqual([]);
      expect(result.violations).toEqual([{ layer: "compaction", kind: "declined", label: verdict }]);
    });
  }

  it("declines when the conversation cannot be assessed at all (fail closed)", async () => {
    const result = await run({ assess: async () => undefined });
    expect(result.compacted).toBe(false);
    expect(result.summarizerSaw).toEqual([]);
    expect(result.violations[0]).toMatchObject({ layer: "compaction", kind: "declined" });
  });

  it("declines when the messages it would summarize hold a forbidden value, even though the assessment was clean", async () => {
    const result = await run({ assess: async () => clean, forbidden: [{ label: "sensitive-field", value: "SECRET-TOKEN-77" }], marker: "SECRET-TOKEN-77" });
    expect(result.compacted).toBe(false);
    expect(result.summarizerSaw).toEqual([]);
    // The same value in the q2 prompt is also withheld from that turn's own request; only the compaction layer's record matters here.
    expect(result.violations.filter((violation) => violation.layer === "compaction")).toEqual([{ layer: "compaction", kind: "declined", label: "sensitive-field" }]);
  });
});
