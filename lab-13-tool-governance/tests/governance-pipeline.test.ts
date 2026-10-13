import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import type { AuditLog, AuditRecord } from "../src/audit-log.js";
import { createBookingRegistry, offeredToolNames, openHarness } from "../src/create-harness.js";
import { GOVERNANCE_EXTENSION_NAME, GOVERNED_TOOL_NAME } from "../src/governance-hooks.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { errorDiagnostic, listEntries, messageText } from "../src/transcript.js";
import {
  afterToolFailingAuditLog,
  alwaysFailingAuditLog,
  createFauxModels,
  recordingAuditLog,
  SpyBookingRepository,
  withTempSessionsRoot,
} from "./helpers.js";

/**
 * The mechanism tests. A real `Harness` runs a real durable `pi.tool` task over a scripted model, so
 * what is asserted here is what the harness actually does with this lab's hooks — not what its source
 * is read to say. Nothing calls a provider.
 */

const ctx = BACKGROUND_CONTEXT;

type Sink = "recording" | "fails-after-tool-only" | "fails-every-write";

interface CallOptions {
  /** Whether the root conversation offers `update_booking_status`. */
  offer: boolean;
  sink?: Sink;
  simulatePolicyBug?: boolean;
  /** The one tool call the scripted model makes. */
  call?: { name: string; args: Record<string, unknown> };
  /** Runs after the harness is open and before the prompt, with the registry the harness uses. */
  beforeSubmit?: (booking: ReturnType<typeof createBookingRegistry>) => void;
}

async function runOneToolCall(options: CallOptions) {
  return withTempSessionsRoot(async (sessionsRoot) => {
    const { faux, models, selection } = createFauxModels();
    const call = options.call ?? { name: GOVERNED_TOOL_NAME, args: { bookingNo: "BK1001", newStatus: "in_transit" } };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(call.name, call.args as never, { id: "call-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("final answer"),
    ]);

    const repository = new SpyBookingRepository();
    let auditLog: AuditLog;
    let records: AuditRecord[] = [];
    if (options.sink === "fails-every-write") {
      auditLog = alwaysFailingAuditLog();
    } else {
      ({ auditLog, records } = options.sink === "fails-after-tool-only" ? afterToolFailingAuditLog() : recordingAuditLog());
    }

    const booking = createBookingRegistry({
      sessionId: "session-a",
      auditLog,
      repository,
      simulatePolicyBug: options.simulatePolicyBug,
    });
    const reports: unknown[] = [];
    const { storage } = await openSessionStorage(sessionsRoot, "session-a", ctx);
    const { harness, root } = await openHarness(
      storage,
      { models, selection, booking, offerGovernedTool: options.offer, onReport: (error) => reports.push(error) },
      ctx,
    );
    options.beforeSubmit?.(booking);

    const settled = await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    const entries = await listEntries(root, ctx);
    const toolResult = entries.find((entry) => entry.kind === "pi.tool-result");
    const system = entries.find((entry) => entry.kind === "pi.system");
    const unfinished = (await harness.inspect(ctx)).tasks;
    await harness.close(ctx);

    return {
      settled,
      repository,
      records,
      reports,
      conversationId: root.id,
      toolResult,
      resultText: toolResult?.model?.[0] ? messageText(toolResult.model[0]) : "",
      resultIsError: toolResult?.model?.[0]?.role === "toolResult" && toolResult.model[0].isError,
      code: errorDiagnostic(toolResult)?.code,
      offeredToModel: toolNamesAdded(system),
      unfinishedTasks: unfinished.length,
    };
  });
}

function toolNamesAdded(system: EntryRecord | undefined): string[] {
  const message = system?.model?.[0] as { toolsAdded?: { name: string }[] } | undefined;
  return message?.toolsAdded?.map((tool) => tool.name) ?? [];
}

describe("gate 1 — active-tool configuration: is the tool offered at all?", () => {
  it("a tool that is not offered is not in the declarations the model receives", async () => {
    const result = await runOneToolCall({ offer: false });
    expect(result.offeredToModel).toEqual(["get_booking"]);
  });

  it("an offered governed tool is declared to the model next to the read-only one", async () => {
    const result = await runOneToolCall({ offer: true });
    expect(result.offeredToModel).toEqual(["get_booking", GOVERNED_TOOL_NAME]);
  });

  it("a call to a tool that is not offered is refused as tool_unavailable — and beforeTool never ran", async () => {
    const result = await runOneToolCall({ offer: false });

    expect(result.settled.status).toBe("done");
    expect(result.resultIsError).toBe(true);
    expect(result.code).toBe("tool_unavailable");
    // `beforeTool` writes an audit record for every call to this tool that reaches it. None exists.
    expect(result.records).toEqual([]);
    expect(result.repository.statusChanges).toEqual([]);
  });
});

describe("gate 2 — beforeTool policy: is this specific call allowed?", () => {
  it("blocks the prohibited cancellation: a durable error result, an audit record, no effect, no afterTool", async () => {
    const result = await runOneToolCall({
      offer: true,
      call: { name: GOVERNED_TOOL_NAME, args: { bookingNo: "BK1001", newStatus: "cancelled" } },
    });

    expect(result.settled.status).toBe("done");
    expect(result.resultIsError).toBe(true);
    expect(result.code).toBe("blocked");
    expect(result.resultText).toMatch(/Tool call blocked: Cancellation is not permitted/);
    expect(result.records.map((record) => `${record.phase}:${record.decision}`)).toEqual(["before_tool:blocked"]);
    expect(result.repository.statusChanges).toEqual([]);
    expect(result.repository.findByBookingNo("BK1001")?.status).toBe("booked");
  });

  it("blocks a change to a delivered booking, read from current state, not from the request", async () => {
    const result = await runOneToolCall({
      offer: true,
      call: { name: GOVERNED_TOOL_NAME, args: { bookingNo: "BK1003", newStatus: "in_transit" } },
    });

    expect(result.code).toBe("blocked");
    expect(result.resultText).toMatch(/already delivered/);
    expect(result.repository.statusChanges).toEqual([]);
  });

  it("allows an ordinary transition: the effect happens and both phases are audited under the same ids", async () => {
    const result = await runOneToolCall({ offer: true });

    expect(result.resultIsError).toBe(false);
    expect(result.repository.statusChanges).toEqual([{ bookingNo: "BK1001", newStatus: "in_transit" }]);
    expect(result.records.map((record) => `${record.phase}:${record.decision}`)).toEqual([
      "before_tool:allowed",
      "after_tool:executed",
    ]);

    const [before, after] = result.records;
    expect(before?.sessionId).toBe("session-a");
    expect(before?.conversationId).toBe(result.conversationId);
    expect(before?.toolCallId).toBe("call-1");
    expect(typeof before?.taskId).toBe("number");
    // One tool call is one `pi.tool` task: both hooks see the same task id, which is the join key.
    expect(after?.taskId).toBe(before?.taskId);
    expect(after?.toolCallId).toBe(before?.toolCallId);
    expect(result.reports).toEqual([]);
  });

  it("an allowed call whose execute() throws (unknown booking) is `errored` after the fact — not `blocked`", async () => {
    const result = await runOneToolCall({
      offer: true,
      call: { name: GOVERNED_TOOL_NAME, args: { bookingNo: "BK9999", newStatus: "in_transit" } },
    });

    expect(result.code).toBe("tool_error");
    expect(result.records.map((record) => `${record.phase}:${record.decision}`)).toEqual([
      "before_tool:allowed",
      "after_tool:errored",
    ]);
  });

  it("schema validation happens before beforeTool: an impossible status is refused with no policy decision and no audit record", async () => {
    const result = await runOneToolCall({
      offer: true,
      call: { name: GOVERNED_TOOL_NAME, args: { bookingNo: "BK1001", newStatus: "teleported" } },
    });

    expect(result.code).toBe("invalid_arguments");
    expect(result.records).toEqual([]);
    expect(result.repository.statusChanges).toEqual([]);
  });

  it("never touches the read-only tool: get_booking runs with no policy decision and no audit record", async () => {
    const result = await runOneToolCall({ offer: true, call: { name: "get_booking", args: { bookingNo: "BK1001" } } });

    expect(result.resultIsError).toBe(false);
    expect(result.records).toEqual([]);
    // A multi-container booking comes back with every container.
    expect(result.resultText).toContain("MSKU1234567");
    expect(result.resultText).toContain("MSKU2345678");
  });
});

describe("failure injection — what happens when the governance code itself fails", () => {
  it("a throwing policy hook blocks the call (fail-closed): no effect, and the throw's message is the block reason", async () => {
    const result = await runOneToolCall({ offer: true, simulatePolicyBug: true });

    expect(result.code).toBe("blocked");
    expect(result.resultText).toMatch(/Tool call blocked: Simulated bug in the beforeTool policy hook/);
    expect(result.repository.statusChanges).toEqual([]);
    // The hook threw before it audited anything: fail-closed does not depend on auditing succeeding.
    expect(result.records).toEqual([]);
  });

  it("an audit sink that fails in beforeTool blocks even a call the policy would have allowed (fail-closed)", async () => {
    const result = await runOneToolCall({ offer: true, sink: "fails-every-write" });

    expect(result.code).toBe("blocked");
    expect(result.resultText).toMatch(/Simulated audit-sink failure \(every write\)/);
    expect(result.repository.statusChanges).toEqual([]);
  });

  it("a policy bug and an audit-sink failure end identically: the same `blocked` code, told apart only by the message", async () => {
    const bug = await runOneToolCall({ offer: true, simulatePolicyBug: true });
    const sink = await runOneToolCall({ offer: true, sink: "fails-every-write" });

    expect(bug.code).toBe("blocked");
    expect(sink.code).toBe("blocked");
    expect(bug.resultText).not.toEqual(sink.resultText);
  });

  it("an audit sink that fails only in afterTool does NOT undo the effect (fail-open): the call succeeds, the audit record is missing", async () => {
    const result = await runOneToolCall({ offer: true, sink: "fails-after-tool-only" });

    expect(result.resultIsError).toBe(false);
    expect(result.code).toBeUndefined();
    expect(result.repository.statusChanges).toEqual([{ bookingNo: "BK1001", newStatus: "in_transit" }]);
    // The decision was recorded; the execution was not.
    expect(result.records.map((record) => `${record.phase}:${record.decision}`)).toEqual(["before_tool:allowed"]);
    // Nothing is left half-done: the task settled normally.
    expect(result.settled.status).toBe("done");
    expect(result.unfinishedTasks).toBe(0);
  });

  it("the swallowed afterTool failure is not silent: it reaches onReport", async () => {
    const result = await runOneToolCall({ offer: true, sink: "fails-after-tool-only" });

    expect(result.reports).toHaveLength(1);
    expect((result.reports[0] as Error).message).toBe("Simulated audit-sink failure (after_tool phase only).");
  });
});

describe("an audit record joins the transcript through its toolCallId", () => {
  // A Pi 1.1 hook is given no run id, no lane, and no turn id, and the audit record invents none. What it
  // does carry — `toolCallId` and `conversationId` — is enough to recover all of them from durable entries.
  it("finds the record's turn, its tool result, its conversation, and its run, for a blocked call and an allowed one", async () => {
    await withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, models, selection } = createFauxModels();
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(GOVERNED_TOOL_NAME, { bookingNo: "BK1001", newStatus: "cancelled" } as never, { id: "call-blocked" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("rejected"),
        fauxAssistantMessage(
          fauxToolCall(GOVERNED_TOOL_NAME, { bookingNo: "BK1001", newStatus: "in_transit" } as never, { id: "call-allowed" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);

      const { auditLog, records } = recordingAuditLog();
      const booking = createBookingRegistry({ sessionId: "session-a", auditLog });
      const { storage } = await openSessionStorage(sessionsRoot, "session-a", ctx);
      const { harness, root } = await openHarness(storage, { models, selection, booking, offerGovernedTool: true }, ctx);

      const first = await (await root.submit({ type: "input", content: "cancel it" }, ctx)).wait(ctx);
      const second = await (await root.submit({ type: "input", content: "move it" }, ctx)).wait(ctx);
      // A settled `done` record is either an answered input or a passive entry write; only an input has an `answer`.
      const span = (record: typeof first) => {
        if (record.status !== "done" || record.type !== "input") throw new Error("both turns must settle as answered inputs");
        return { id: record.id, entry: record.entry, answer: record.answer };
      };
      const runs = [span(first), span(second)];
      const entries = await listEntries(root, ctx);
      await harness.close(ctx);

      const turnOf = (toolCallId: string) =>
        entries.find(
          (entry) =>
            entry.kind === "pi.assistant" &&
            entry.model?.[0]?.role === "assistant" &&
            entry.model[0].content.some((block) => block.type === "toolCall" && block.id === toolCallId),
        );
      const resultOf = (toolCallId: string) =>
        entries.find((entry) => entry.kind === "pi.tool-result" && (entry.model?.[0] as { toolCallId?: string })?.toolCallId === toolCallId);
      // Entry ids come from one counter, so a turn belongs to the submission whose [entry, answer] range holds it.
      const runOf = (turnId: number) => runs.find((each) => each.entry < turnId && turnId <= each.answer);

      for (const { toolCallId, submission, code } of [
        { toolCallId: "call-blocked", submission: runs[0]!, code: "blocked" },
        { toolCallId: "call-allowed", submission: runs[1]!, code: undefined },
      ]) {
        const record = records.find((each) => each.toolCallId === toolCallId && each.phase === "before_tool");
        const turn = turnOf(toolCallId);
        const result = resultOf(toolCallId);

        expect(record, `${toolCallId}: audit record`).toBeDefined();
        expect(turn, `${toolCallId}: the assistant entry that requested it`).toBeDefined();
        expect(result, `${toolCallId}: the tool-result entry`).toBeDefined();
        expect(record?.conversationId).toBe(root.id);
        expect(result!.id).toBeGreaterThan(turn!.id);
        expect(errorDiagnostic(result)?.code).toBe(code);
        expect(runOf(turn!.id)?.id).toBe(submission.id);
      }

      // The two calls land in different runs: the join does not collapse them into one.
      expect(runOf(turnOf("call-blocked")!.id)?.id).not.toBe(runOf(turnOf("call-allowed")!.id)?.id);
    });
  });
});

describe("the tool and its guard travel together", () => {
  it("the registry holds the governed tool only inside the extension that also holds its hooks", async () => {
    const { auditLog } = recordingAuditLog();
    const { registry } = createBookingRegistry({ sessionId: "session-a", auditLog });
    const snapshot = registry.snapshot();

    const owners = snapshot.tools().filter(({ tool }) => tool.name === GOVERNED_TOOL_NAME);
    expect(owners.map(({ extension }) => extension.name)).toEqual([GOVERNANCE_EXTENSION_NAME]);
    expect(owners[0]?.extension.hooks).toHaveLength(1);
  });

  it("with the governance extension gone from the registry the tool is gone too — it cannot run ungoverned", async () => {
    const result = await runOneToolCall({
      offer: true,
      beforeSubmit: ({ registry }) => {
        const governance = registry.snapshot().extension(GOVERNANCE_EXTENSION_NAME);
        if (!governance) throw new Error("governance extension was never installed");
        registry.uninstall(governance);
      },
    });

    expect(result.code).toBe("tool_unavailable");
    expect(result.repository.statusChanges).toEqual([]);
  });
});

describe("what a conversation offers is durable state", () => {
  it("a new session offers only get_booking; asking for the governed tool offers both; a later process inherits it", async () => {
    await withTempSessionsRoot(async (sessionsRoot) => {
      const { models, selection } = createFauxModels();
      const open = async (offerGovernedTool?: boolean) => {
        const { auditLog } = recordingAuditLog();
        const booking = createBookingRegistry({ sessionId: "session-a", auditLog });
        const { storage, created } = await openSessionStorage(sessionsRoot, "session-a", ctx);
        const opened = await openHarness(storage, { models, selection, booking, offerGovernedTool }, ctx);
        return { ...opened, created, offered: await offeredToolNames(opened.root, ctx) };
      };

      const first = await open();
      expect(first.created).toBe(true);
      expect(first.offered).toEqual(["get_booking"]);
      await first.harness.close(ctx);

      const second = await open(true);
      expect(second.created).toBe(false);
      expect(second.offered).toEqual(["get_booking", GOVERNED_TOOL_NAME]);
      await second.harness.close(ctx);

      // A third process does not pass the flag. It does not take the tool away.
      const third = await open();
      expect(third.offered).toEqual(["get_booking", GOVERNED_TOOL_NAME]);
      await third.harness.close(ctx);
    });
  });
});
