import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { AttemptLog } from "../src/attempt-log.js";
import { openRootConversation } from "../src/create-harness.js";
import { attachTraceLogger } from "../src/harness-trace-logger.js";
import { OutboxRepository } from "../src/outbox-repository.js";
import { BACKGROUND_CONTEXT, openSessionStorage, sessionDirectory } from "../src/session-store.js";
import { listEntries } from "../src/transcript.js";
import { createFauxModels, createTestRegistry, withTempDir } from "./helpers.js";

/**
 * A SIGKILL leaves exactly the bytes already on disk. These tests reproduce that without killing
 * anything: at a tool's named checkpoint, which fires synchronously inside `execute()`, the session
 * directory, the attempt log, and the outbox are all copied to a second directory. That copy is the
 * disk a killed process would have left, taken at the same moment the live demo kills at, with no
 * sleeps and no model. A brand-new Harness over the copy then recovers. `process A` is the one that
 * "dies" (it simply keeps running after the copy, which is irrelevant); `process B` is the recovery.
 */

const ctx = BACKGROUND_CONTEXT;
const SESSION = "conversation-replay";

type Crash = "safe" | "unsafe";

interface Snapshot {
  sessionsRoot: string;
  attemptsPath: string;
  outboxPath: string;
}

const PROMPTS = {
  safe: "What are the movement events for container MSKU1234567?",
  unsafe: 'Please place a hold on booking BK1001 for "customs review" and tell me the hold id.',
} as const;

function toolCall(kind: Crash) {
  return kind === "safe"
    ? fauxToolCall("get_container_events", { containerNo: "MSKU1234567" }, { id: "call-1" })
    : fauxToolCall("request_booking_hold", { bookingNo: "BK1001", reason: "customs review" }, { id: "call-1" });
}

/** Process A: runs until the named checkpoint of `kind`, copies "the disk" there, then carries on. */
interface Declarations {
  /** `replay` the hold tool is installed with in the process that dies. */
  crashReplay?: "safe" | "unsafe";
  /** `replay` the hold tool is installed with in the process that recovers. */
  recoverReplay?: "safe" | "unsafe";
}

async function crashAt(kind: Crash, work: string, snapshot: Snapshot, options: Declarations = {}) {
  const { faux, models, selection } = createFauxModels();
  faux.setResponses([
    fauxAssistantMessage(toolCall(kind), { stopReason: "toolUse" }),
    fauxAssistantMessage("A's answer, which the killed process never gets to commit before the copy."),
  ]);

  const evidenceA = join(work, "a");
  const takeSnapshot = () => {
    cpSync(sessionDirectory(join(evidenceA, "sessions"), SESSION), sessionDirectory(snapshot.sessionsRoot, SESSION), { recursive: true });
    for (const [from, to] of [
      [join(evidenceA, "attempts.jsonl"), snapshot.attemptsPath],
      [join(evidenceA, "outbox.jsonl"), snapshot.outboxPath],
    ] as const) {
      if (existsSync(from)) {
        cpSync(from, to);
      }
    }
  };

  const { storage } = await openSessionStorage(join(evidenceA, "sessions"), SESSION, ctx);
  const { registry } = createTestRegistry(evidenceA, {
    attemptLog: new AttemptLog(join(evidenceA, "attempts.jsonl")),
    outbox: new OutboxRepository(join(evidenceA, "outbox.jsonl")),
    safeTool: { onDispatch: kind === "safe" ? takeSnapshot : () => {} },
    holdTool: {
      onEffectAppended: kind === "unsafe" ? takeSnapshot : () => {},
      ...(options.crashReplay ? { replay: options.crashReplay } : {}),
    },
  });
  const { harness, root } = await openRootConversation(storage, { models, selection, registry }, ctx);

  const submission = await root.submit({ type: "input", content: PROMPTS[kind] }, ctx);
  await submission.wait(ctx);
  await harness.close(ctx);
  return { submissionId: submission.id };
}

/** Process B: a brand-new Harness over the copied disk, with its own scripted model. */
async function openRecovered(
  snapshot: Snapshot,
  responses: ReturnType<typeof fauxAssistantMessage>[],
  options: Declarations = {},
) {
  const { faux, models, selection } = createFauxModels();
  faux.setResponses(responses);
  const attemptLog = new AttemptLog(snapshot.attemptsPath);
  const outbox = new OutboxRepository(snapshot.outboxPath);
  const { storage } = await openSessionStorage(snapshot.sessionsRoot, SESSION, ctx);
  const { registry } = createTestRegistry(join(snapshot.sessionsRoot, ".."), {
    attemptLog,
    outbox,
    holdTool: options.recoverReplay ? { replay: options.recoverReplay } : {},
  });
  const opened = await openRootConversation(storage, { models, selection, registry }, ctx);
  return { ...opened, attemptLog, outbox, faux };
}

async function scenario(
  kind: Crash,
  responsesAfterCrash: ReturnType<typeof fauxAssistantMessage>[],
  body: (recovered: Awaited<ReturnType<typeof openRecovered>> & { submissionId: Awaited<ReturnType<typeof crashAt>>["submissionId"]; attemptsAtCrash: number }) => Promise<void>,
  options: Declarations = {},
) {
  await withTempDir(async (work) => {
    const snapshot: Snapshot = {
      sessionsRoot: join(work, "b", "sessions"),
      attemptsPath: join(work, "b", "attempts.jsonl"),
      outboxPath: join(work, "b", "outbox.jsonl"),
    };
    const { submissionId } = await crashAt(kind, work, snapshot, options);
    const recovered = await openRecovered(snapshot, responsesAfterCrash, options);
    try {
      await body({ ...recovered, submissionId, attemptsAtCrash: recovered.attemptLog.readAll().length });
    } finally {
      await recovered.harness.close(ctx);
    }
  });
}

async function recover(recovered: Awaited<ReturnType<typeof openRecovered>>, submissionId: Awaited<ReturnType<typeof crashAt>>["submissionId"]) {
  recovered.harness.resume();
  const settled = await (await recovered.harness.submission(submissionId, ctx))?.wait(ctx);
  expect(settled?.status).toBe("done");
  return listEntries(recovered.root, ctx);
}

const resultOf = (entries: Awaited<ReturnType<typeof listEntries>>) =>
  entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => entry.model?.[0]);

describe("tool replay safety across a crash", () => {
  it('replay "safe": recovery runs the tool again — two attempts, one logical call, one committed result', () =>
    scenario("safe", [fauxAssistantMessage("MSKU1234567 departed CNSHA.")], async (recovered) => {
      const { attemptLog, outbox, inspection, submissionId, attemptsAtCrash } = recovered;

      // What the kill left behind: one real attempt, nothing committed for it.
      expect(attemptsAtCrash).toBe(1);
      expect(inspection.tasks.map((task) => task.record.kind).sort()).toEqual(["pi.generation", "pi.tool"]);
      const killed = attemptLog.readAll()[0];

      const entries = await recover(recovered, submissionId);

      const attempts = attemptLog.readAll();
      expect(attempts).toHaveLength(2);
      // A replay is the *same* logical call: same task id, same call id. It is not a new request.
      expect(attempts[1]).toMatchObject({ tool: "get_container_events", taskId: killed?.taskId, callId: killed?.callId });
      expect(new Set(attempts.map((a) => a.taskId)).size).toBe(1);
      expect(new Set(attempts.map((a) => a.callId)).size).toBe(1);

      // Two executions, one durable result, and it is the real one (not an `interrupted` error).
      const results = resultOf(entries);
      expect(results).toHaveLength(1);
      expect(results[0]?.role === "toolResult" && results[0].isError).toBe(false);
      expect(JSON.stringify(results[0])).toContain("DEPARTURE");
      expect(outbox.readAll()).toEqual([]);
      expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
    }));

  it('replay "unsafe": recovery does not run the tool again — one attempt, one effect, an interrupted result', () =>
    scenario("unsafe", [fauxAssistantMessage("The hold outcome is unknown.")], async (recovered) => {
      const { attemptLog, outbox, inspection, submissionId } = recovered;

      // What the kill left behind: the local effect already happened, the result did not commit.
      expect(attemptLog.readAll()).toHaveLength(1);
      expect(outbox.readAll()).toHaveLength(1);
      expect(inspection.tasks.map((task) => task.record.kind).sort()).toEqual(["pi.generation", "pi.tool"]);
      const effect = outbox.readAll()[0];

      const entries = await recover(recovered, submissionId);

      expect(attemptLog.readAll()).toHaveLength(1);
      expect(outbox.readAll()).toEqual([effect]);
      const results = resultOf(entries);
      expect(results).toHaveLength(1);
      expect(results[0]?.role === "toolResult" && results[0].isError).toBe(true);
      expect(JSON.stringify(results[0])).toMatch(/interrupt/i);
      // The effect and the attempt share identity: the one thing that happened is the one thing Pi calls interrupted.
      expect(attemptLog.readAll()[0]).toMatchObject({ taskId: effect?.taskId, callId: effect?.callId });
      expect(entries.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);
    }));

  // `replay` is a promise the tool author makes. Pi does not check it. A state-changing tool wrongly
  // declared "safe" is replayed, and its effect is duplicated: preventing that is the tool's job.
  it('a state-changing tool wrongly declared "safe" is replayed and duplicates its business effect', () =>
    scenario(
      "unsafe",
      [fauxAssistantMessage("The hold was requested.")],
      async (recovered) => {
        const { attemptLog, outbox, submissionId } = recovered;
        expect(outbox.readAll()).toHaveLength(1);

        const entries = await recover(recovered, submissionId);

        expect(attemptLog.readAll()).toHaveLength(2);
        const effects = outbox.readAll();
        expect(effects).toHaveLength(2);
        // Same logical call, executed twice, two outbox records: this is a duplicate, not a second request.
        expect(effects[0]?.taskId).toBe(effects[1]?.taskId);
        expect(effects[0]?.callId).toBe(effects[1]?.callId);
        expect(resultOf(entries)).toHaveLength(1);
      },
      { crashReplay: "safe", recoverReplay: "safe" },
    ));

  // Recovery reruns a call only when BOTH say "safe": the policy committed with the call's intent (what the
  // dying process had installed) and the policy of the tool the recovering process has installed (pi-durable
  // `harness/tool.js`: `replay === "safe" && tool?.replay === "safe"`). Either side being "unsafe" is enough
  // to stop it. Both directions are pinned here so neither gate is assumed.
  it.each([
    ["unsafe", "safe", "the policy stored at intent time wins over a newly installed safe tool"],
    ["safe", "unsafe", "the currently installed unsafe tool wins over a stored safe policy"],
  ] as const)("does not rerun when the call was %s at crash time and %s at recovery: %s", (crashReplay, recoverReplay, _why) =>
    scenario(
      "unsafe",
      [fauxAssistantMessage("The hold outcome is unknown.")],
      async (recovered) => {
        const { attemptLog, outbox, submissionId } = recovered;
        expect(outbox.readAll()).toHaveLength(1);

        const entries = await recover(recovered, submissionId);

        expect(attemptLog.readAll()).toHaveLength(1);
        expect(outbox.readAll()).toHaveLength(1);
        const results = resultOf(entries);
        expect(results[0]?.role === "toolResult" && results[0].isError).toBe(true);
      },
      { crashReplay, recoverReplay },
    ));

  it("re-reading a settled submission returns its stored record and executes nothing", () =>
    scenario("unsafe", [fauxAssistantMessage("The hold outcome is unknown.")], async (recovered) => {
      const { attemptLog, outbox, submissionId, faux } = recovered;
      recovered.harness.resume();
      const first = await (await recovered.harness.submission(submissionId, ctx))?.wait(ctx);
      const entriesAfterFirst = await listEntries(recovered.root, ctx);

      const second = await (await recovered.harness.submission(submissionId, ctx))?.wait(ctx);

      expect(second).toEqual(first);
      expect(await listEntries(recovered.root, ctx)).toEqual(entriesAfterFirst);
      expect(attemptLog.readAll()).toHaveLength(1);
      expect(outbox.readAll()).toHaveLength(1);
      expect(faux.state.callCount).toBe(1);
    }));

  // The recovered trace is where the two policies are visible side by side. Neither has a `tool_start`
  // here; the suffix on `tool_end` says whether recovery ran the call again or gave up on it.
  it.each([
    [
      "safe",
      "MSKU1234567 departed CNSHA.",
      [
        "↺ ▶ run (began before the restart)",
        "  ↺ ▶ turn #1 (began before the restart)",
        "    ◀ tool_end get_container_events status=success ↺ no tool_start in this process: recovery ran the call again",
        "    toolResult get_container_events status=success entry=N",
      ],
    ],
    [
      "unsafe",
      "The hold outcome is unknown.",
      [
        "↺ ▶ run (began before the restart)",
        "  ↺ ▶ turn #1 (began before the restart)",
        "    ◀ tool_end request_booking_hold status=error ↺ interrupted: the previous process died mid-call; recovery committed an error result and did not run the tool again",
        "    toolResult request_booking_hold status=error entry=N",
      ],
    ],
  ] as const)("traces the recovered run for a %s tool", (kind, answer, expectedHead) =>
    scenario(kind, [fauxAssistantMessage(answer)], async (recovered) => {
      const lines: string[] = [];
      const trace = await attachTraceLogger(recovered.harness, recovered.root.id, (line) => lines.push(line), ctx);
      recovered.harness.resume();
      const settled = await (await recovered.harness.submission(recovered.submissionId, ctx))?.wait(ctx);
      await trace.settled(recovered.submissionId);
      await trace.stop();
      expect(settled?.status).toBe("done");

      const normalized = lines.map((line) => line.replace(/entry=\d+/g, "entry=N").replace(/inputs=\[\d+\]/g, "inputs=[N]"));
      expect(normalized).toEqual([
        ...expectedHead,
        "  ◀ turn_end #1 tool_results=1",
        "  ▶ turn #2",
        `    [Assistant] entry=N ${answer}`,
        "  ◀ turn_end #2 tool_results=0",
        "◀ run_end inputs=[N]",
      ]);
    }));
});
