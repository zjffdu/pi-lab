import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, EntryRecord, Harness, Storage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { forkAt, listConversationRecords, loadBranches } from "../src/branches.js";
import { createBookingRegistry, openHarness } from "../src/create-harness.js";
import { readLabels, setLabel } from "../src/labels.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { entryText, listEntries } from "../src/transcript.js";
import { branchTips, inheritedEntries, ownEntries, renderTree } from "../src/tree-view.js";
import { createFauxModels, plainText, withTempSessionsRoot } from "./helpers.js";

/**
 * Everything here runs the real `Harness` over real JSONL storage with a scripted model. Going back to an
 * earlier entry and changing the premise is `Conversation.fork(entryId)`, which creates a second conversation
 * that shares its parent's history up to that entry. So "which branch sees which context" is a property of
 * committed records, and the scripted model lets each test read the exact messages a branch's next request
 * would carry.
 */

const ctx = BACKGROUND_CONTEXT;

type Faux = ReturnType<typeof createFauxModels>["faux"];
type Replies = Parameters<Faux["setResponses"]>[0];

function setup() {
  const { faux, models, selection } = createFauxModels();

  /** One process: open the storage, attach a harness, run `body`, close. Call twice to model a restart. */
  async function runProcess<T>(
    sessionsRoot: string,
    body: (attached: { harness: Harness; storage: Storage; root: Conversation }) => Promise<T>,
  ): Promise<T> {
    const { storage } = await openSessionStorage(sessionsRoot, "conversation-a", ctx);
    const { harness, root } = await openHarness(storage, { models, selection, registry: createBookingRegistry() }, ctx);
    try {
      return await body({ harness, storage, root });
    } finally {
      await harness.close(ctx);
    }
  }

  return { faux, runProcess };
}

async function turn(faux: Faux, conversation: Conversation, prompt: string, replies: Replies) {
  faux.setResponses(replies);
  const settled = await (await conversation.submit({ type: "input", content: prompt }, ctx)).wait(ctx);
  expect(settled.status).toBe("done");
}

function lookup(bookingNo: string, id: string, answer: string): Replies {
  return [
    fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo }, { id }), { stopReason: "toolUse" }),
    fauxAssistantMessage(answer),
  ];
}

/**
 * Branch A: BK1001 looked up, both of its containers checked, a risk call. Returns the id of the entry that
 * ends turn 1 — the meaningful point to branch from — and of the last entry.
 */
async function seedBranchA(faux: Faux, root: Conversation) {
  await turn(faux, root, "Look up booking BK1001.", lookup("BK1001", "c1", "BK1001: CNSHA to NLRTM on MAERSK TEST, containers MSKU1234567 and MSKU2345678."));
  const afterLookup = (await listEntries(root, ctx)).at(-1)!;
  await turn(faux, root, "Events for every container of BK1001?", [
    fauxAssistantMessage(
      [
        fauxToolCall("get_container_events", { containerNo: "MSKU1234567" }, { id: "c2a" }),
        fauxToolCall("get_container_events", { containerNo: "MSKU2345678" }, { id: "c2b" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Both containers of BK1001 departed CNSHA on 2026-09-10."),
  ]);
  await turn(faux, root, "On schedule or at risk?", [fauxAssistantMessage("On schedule.")]);
  const tip = (await listEntries(root, ctx)).at(-1)!;
  return { afterLookup, tip };
}

const ids = (entries: readonly EntryRecord[]) => entries.map((entry) => entry.id);

describe("fork(at): a second conversation that shares history up to one entry", () => {
  it("inherits exactly the entries up to and including the fork point, keeping the parent's conversationId", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ harness, storage, root }) => {
        const { afterLookup, tip } = await seedBranchA(faux, root);
        const rootEntries = await listEntries(root, ctx);

        const fork = await forkAt(root, afterLookup.id, ctx);
        const forkEntries = await listEntries(fork, ctx);

        expect(afterLookup.id).toBeLessThan(tip.id);
        expect(ids(forkEntries)).toEqual(ids(rootEntries.filter((entry) => entry.id <= afterLookup.id)));
        expect(forkEntries.every((entry) => entry.conversationId === root.id)).toBe(true);

        const records = await listConversationRecords(storage, ctx);
        expect(records.find((record) => record.id === fork.id)?.parent).toEqual({ conversationId: root.id, at: afterLookup.id });
        expect(records.find((record) => record.id === root.id)?.parent).toBeUndefined();

        const branches = await loadBranches(harness, storage, ctx);
        const forkBranch = branches.find((branch) => branch.record.id === fork.id)!;
        expect(ownEntries(forkBranch)).toEqual([]);
        expect(ids(inheritedEntries(forkBranch))).toEqual(ids(forkEntries));
      });
    }));

  it("leaves the parent untouched, and a fork's own turns never reach the parent", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ root }) => {
        const { afterLookup } = await seedBranchA(faux, root);
        const rootBefore = await listEntries(root, ctx);

        const fork = await forkAt(root, afterLookup.id, ctx);
        expect(await listEntries(root, ctx)).toEqual(rootBefore);

        await turn(faux, fork, "Actually the booking is BK1002. Look it up.", lookup("BK1002", "f1", "BK1002: SGSIN to USLAX on MAERSK SECOND."));

        expect(await listEntries(root, ctx)).toEqual(rootBefore);
        const forkEntries = await listEntries(fork, ctx);
        expect(ids(forkEntries).slice(0, ids(inheritedEntries({ record: { id: fork.id }, entries: forkEntries })).length)).toEqual(
          ids(rootBefore.filter((entry) => entry.id <= afterLookup.id)),
        );
        expect(forkEntries.at(-1)?.conversationId).toBe(fork.id);
      });
    }));

  it("keeps the fork independent when the parent keeps going afterwards", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ root }) => {
        const { afterLookup } = await seedBranchA(faux, root);
        const fork = await forkAt(root, afterLookup.id, ctx);
        const forkBefore = await listEntries(fork, ctx);

        await turn(faux, root, "One more question on BK1001.", [fauxAssistantMessage("Nothing further.")]);

        expect(await listEntries(fork, ctx)).toEqual(forkBefore);
      });
    }));

  it("lets a fork be forked again, and the second fork inherits the whole chain", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ harness, storage, root }) => {
        const { afterLookup } = await seedBranchA(faux, root);
        const fork = await forkAt(root, afterLookup.id, ctx);
        await turn(faux, fork, "Actually BK1002.", lookup("BK1002", "f1", "BK1002: SGSIN to USLAX on MAERSK SECOND."));
        const forkEntries = await listEntries(fork, ctx);
        const forkQuestion = forkEntries.find((entry) => entry.conversationId === fork.id)!;

        const nested = await forkAt(fork, forkQuestion.id, ctx);
        const nestedEntries = await listEntries(nested, ctx);

        expect(ids(nestedEntries)).toEqual(ids(forkEntries.filter((entry) => entry.id <= forkQuestion.id)));
        expect(nestedEntries.map((entry) => entry.conversationId)).toContain(root.id);
        expect(nestedEntries.map((entry) => entry.conversationId)).toContain(fork.id);

        const records = await listConversationRecords(storage, ctx);
        expect(records.find((record) => record.id === nested.id)?.parent).toEqual({ conversationId: fork.id, at: forkQuestion.id });
        expect(branchTips(await loadBranches(harness, storage, ctx))).toHaveLength(3);
      });
    }));
});

describe("each branch sees only its own ancestry", () => {
  // The scripted model records what each request actually carried, so this is checked against the messages
  // the provider would receive, not against `parentId`-style bookkeeping.
  it("sends BK1001's facts down one branch and BK1002's down the other, never both", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();
      const requests: { branch: string; text: string }[] = [];
      const capture = (branch: string, answer: string) => (context: { messages: readonly { role: string; content?: unknown }[] }) => {
        requests.push({ branch, text: plainText(context.messages) });
        return fauxAssistantMessage(answer);
      };

      await runProcess(sessionsRoot, async ({ root }) => {
        const { afterLookup } = await seedBranchA(faux, root);
        const fork = await forkAt(root, afterLookup.id, ctx);
        await turn(faux, fork, "Actually the booking is BK1002. Look it up.", lookup("BK1002", "f1", "BK1002: SGSIN to USLAX on MAERSK SECOND."));

        const question = "Which vessel is the booking we are discussing on?";
        await turn(faux, root, question, [capture("root", "MAERSK TEST")]);
        await turn(faux, fork, question, [capture("fork", "MAERSK SECOND")]);
      });

      const rootRequest = requests.find((request) => request.branch === "root")!.text;
      const forkRequest = requests.find((request) => request.branch === "fork")!.text;

      // Root: its own BK1001 history, including everything after the fork point; nothing from the fork.
      expect(rootRequest).toContain("MAERSK TEST");
      expect(rootRequest).toContain("get_container_events");
      expect(rootRequest).toContain("On schedule.");
      expect(rootRequest).not.toContain("BK1002");
      expect(rootRequest).not.toContain("MAERSK SECOND");

      // Fork: the shared turn 1 and its own BK1002 turn; nothing the root appended after the fork point.
      expect(forkRequest).toContain("Look up booking BK1001.");
      expect(forkRequest).toContain("MAERSK TEST");
      expect(forkRequest).toContain("MAERSK SECOND");
      expect(forkRequest).not.toContain("get_container_events");
      expect(forkRequest).not.toContain("Events for every container of BK1001?");
      expect(forkRequest).not.toContain("departed CNSHA");
      expect(forkRequest).not.toContain("On schedule.");
    }));

  it("previews what a fork would see with context({ at }) without creating one", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ storage, root }) => {
        const { afterLookup } = await seedBranchA(faux, root);
        const recordsBefore = await listConversationRecords(storage, ctx);

        const preview = await root.context(ctx, { at: afterLookup.id });
        expect(recordsBefore).toHaveLength(1);
        expect(await listConversationRecords(storage, ctx)).toEqual(recordsBefore);

        const fork = await forkAt(root, afterLookup.id, ctx);
        const actual = await fork.context(ctx);
        expect(preview.messages).toEqual(actual.messages);
        expect(ids(preview.entries)).toEqual(ids(actual.entries));
        expect(preview.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "toolResult", "assistant"]);
      });
    }));
});

describe("what fork(at) accepts and rejects", () => {
  it("rejects an unknown entry and an entry of an unrelated conversation with the same error", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ harness, root }) => {
        await seedBranchA(faux, root);
        await expect(forkAt(root, 999_999 as never, ctx)).rejects.toThrow(`Entry 999999 is not visible from conversation ${root.id}`);

        const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
        await other.configure({ model: { provider: "faux", modelId: "faux-1" } }, ctx);
        await turn(faux, other, "An unrelated question.", [fauxAssistantMessage("An unrelated answer.")]);
        const foreign = (await listEntries(other, ctx)).at(-1)!;

        await expect(forkAt(root, foreign.id, ctx)).rejects.toThrow(`Entry ${foreign.id} is not visible from conversation ${root.id}`);
      });
    }));

  it("allows forking at the end of a turn, in the middle of one, and at the very last entry", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ root }) => {
        const { tip } = await seedBranchA(faux, root);
        const entries = await listEntries(root, ctx);
        const toolResult = entries.find((entry) => entry.kind === "pi.tool-result")!;

        const atToolResult = await forkAt(root, toolResult.id, ctx);
        expect((await listEntries(atToolResult, ctx)).at(-1)?.id).toBe(toolResult.id);

        const atLast = await forkAt(root, tip.id, ctx);
        expect(ids(await listEntries(atLast, ctx))).toEqual(ids(entries));
      });
    }));

  // A fork at the assistant message that REQUESTED a tool call inherits a call with no result yet. The next
  // request does not break: the context synthesizes a tool result so the provider sees a well-formed transcript.
  it("forking at a tool-call request inherits a call with no result, and the context stays well-formed", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ root }) => {
        await seedBranchA(faux, root);
        const toolCall = (await listEntries(root, ctx)).find((entry) => JSON.stringify(entry.model).includes("toolCall"))!;

        const fork = await forkAt(root, toolCall.id, ctx);
        expect((await listEntries(fork, ctx)).some((entry) => entry.kind === "pi.tool-result")).toBe(false);
        expect((await fork.context(ctx)).messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "toolResult"]);

        await turn(faux, fork, "Continue from here.", [fauxAssistantMessage("Continuing.")]);
      });
    }));
});

describe("both branches stay addressable after a restart", () => {
  it("reopens the storage, finds root and fork with their parent edge intact, and keeps working in the fork", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      const { forkId, afterLookupId, rootTipId } = await runProcess(sessionsRoot, async ({ root }) => {
        const { afterLookup, tip } = await seedBranchA(faux, root);
        const fork = await forkAt(root, afterLookup.id, ctx);
        await turn(faux, fork, "Actually BK1002.", lookup("BK1002", "f1", "BK1002: SGSIN to USLAX on MAERSK SECOND."));
        return { forkId: fork.id, afterLookupId: afterLookup.id, rootTipId: tip.id };
      });

      // A new process: nothing in memory survives, and the registry is installed again by `openHarness`.
      await runProcess(sessionsRoot, async ({ harness, storage, root }) => {
        const records = await listConversationRecords(storage, ctx);
        expect(records.map((record) => record.id)).toEqual([root.id, forkId]);
        expect(records.find((record) => record.id === forkId)?.parent).toEqual({ conversationId: root.id, at: afterLookupId });

        const branches = await loadBranches(harness, storage, ctx);
        const tips = branchTips(branches);
        expect(tips.find((tip) => tip.conversationId === root.id)?.entryId).toBe(rootTipId);
        expect(entryText((await listEntries(root, ctx)).at(-1)!)).toBe("On schedule.");

        const fork = (await harness.conversation(forkId, ctx))!;
        expect(entryText((await listEntries(fork, ctx)).at(-1)!)).toContain("MAERSK SECOND");

        await turn(faux, fork, "Back again, one more on BK1002.", [fauxAssistantMessage("Still BK1002.")]);
        expect(entryText((await listEntries(fork, ctx)).at(-1)!)).toBe("Still BK1002.");
        expect(entryText((await listEntries(root, ctx)).at(-1)!)).toBe("On schedule.");
      });
    }));

  it("renders the same tree after the restart as before it", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      const before = await runProcess(sessionsRoot, async ({ harness, storage, root }) => {
        const { afterLookup } = await seedBranchA(faux, root);
        const fork = await forkAt(root, afterLookup.id, ctx);
        await turn(faux, fork, "Actually BK1002.", lookup("BK1002", "f1", "BK1002: SGSIN to USLAX on MAERSK SECOND."));
        await setLabel(harness, storage, afterLookup.id, "after-bk1001-lookup", ctx);
        return renderTree(await loadBranches(harness, storage, ctx), { labels: await readLabels(harness, ctx) });
      });

      const after = await runProcess(sessionsRoot, async ({ harness, storage }) =>
        renderTree(await loadBranches(harness, storage, ctx), { labels: await readLabels(harness, ctx) }),
      );

      expect(after).toBe(before);
      expect(after).toContain('[label="after-bk1001-lookup"]');
      expect(after).toMatch(/\(fork of \d+ @ entry \d+\)/);
    }));
});

describe("labels (application state, not a Pi feature)", () => {
  it("sets, replaces, and clears a label without touching any transcript", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      await runProcess(sessionsRoot, async ({ harness, storage, root }) => {
        const { afterLookup } = await seedBranchA(faux, root);
        const entriesBefore = await listEntries(root, ctx);

        expect((await readLabels(harness, ctx)).size).toBe(0);

        await setLabel(harness, storage, afterLookup.id, "after-bk1001-lookup", ctx);
        expect((await readLabels(harness, ctx)).get(String(afterLookup.id))).toBe("after-bk1001-lookup");

        await setLabel(harness, storage, afterLookup.id, "renamed", ctx);
        expect((await readLabels(harness, ctx)).get(String(afterLookup.id))).toBe("renamed");

        await setLabel(harness, storage, afterLookup.id, undefined, ctx);
        expect((await readLabels(harness, ctx)).size).toBe(0);

        expect(await listEntries(root, ctx)).toEqual(entriesBefore);
      });
    }));

  it("rejects a label on an entry that does not exist, and survives a restart", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, runProcess } = setup();

      const entryId = await runProcess(sessionsRoot, async ({ harness, storage, root }) => {
        const { afterLookup } = await seedBranchA(faux, root);
        await expect(setLabel(harness, storage, 999_999 as never, "ghost", ctx)).rejects.toThrow("Cannot label unknown entry 999999");
        await setLabel(harness, storage, afterLookup.id, "kept", ctx);
        return afterLookup.id;
      });

      await runProcess(sessionsRoot, async ({ harness }) => {
        expect((await readLabels(harness, ctx)).get(String(entryId))).toBe("kept");
      });
    }));
});
