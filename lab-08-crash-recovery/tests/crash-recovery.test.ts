import { cpSync } from "node:fs";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { createBookingRegistry, openRootConversation } from "../src/create-harness.js";
import { attachTraceLogger } from "../src/harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage, sessionDirectory } from "../src/session-store.js";
import { listEntries } from "../src/transcript.js";
import { createFauxModels, withTempSessionsRoot } from "./helpers.js";

/**
 * A SIGKILL leaves exactly the bytes already committed to the storage directory. These tests
 * reproduce that without killing anything: at the tool's dispatch checkpoint, which fires
 * synchronously inside `execute()`, the session directory is copied to a second root. The copy
 * is the disk a killed process would have left behind, taken at the same named checkpoint the
 * live demo kills at, with no sleeps and no model. A brand-new Harness then recovers from it.
 */

const ctx = BACKGROUND_CONTEXT;
const SESSION = "conversation-crash";
const PROMPT = "What are the movement events for container MSKU1234567?";

async function crashAtDispatch(sessionsRoot: string, snapshotRoot: string) {
  const { faux, models, selection } = createFauxModels();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("get_container_events", { containerNo: "MSKU1234567" }, { id: "call-1" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("MSKU1234567 departed CNSHA."),
  ]);

  const dispatches: { taskId: string; callId: string; containerNo: string }[] = [];
  const { storage } = await openSessionStorage(sessionsRoot, SESSION, ctx);
  const { harness, root } = await openRootConversation(
    storage,
    {
      models,
      selection,
      registry: createBookingRegistry({
        slowTool: {
          delayMs: 0,
          onDispatch: (dispatch) => {
            dispatches.push(dispatch);
            cpSync(sessionDirectory(sessionsRoot, SESSION), sessionDirectory(snapshotRoot, SESSION), { recursive: true });
          },
        },
      }),
    },
    ctx,
  );

  const submission = await root.submit({ type: "input", content: PROMPT }, ctx);
  const settled = await submission.wait(ctx);
  await harness.close(ctx);

  expect(settled.status).toBe("done");
  expect(dispatches).toHaveLength(1);
  return { submissionId: submission.id, dispatch: dispatches[0] };
}

/** "Process B": a brand-new Harness over the snapshot, with a tool that records every real run. */
async function openRecovered(snapshotRoot: string, responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const { faux, models, selection } = createFauxModels();
  faux.setResponses(responses);

  const executions: string[] = [];
  const { storage } = await openSessionStorage(snapshotRoot, SESSION, ctx);
  const opened = await openRootConversation(
    storage,
    { models, selection, registry: createBookingRegistry({ slowTool: { delayMs: 0, onDispatch: (d) => executions.push(d.callId) } }) },
    ctx,
  );
  return { ...opened, executions, faux };
}

describe("crash recovery over JSONL storage", () => {
  it("leaves a placed submission, a pending tool task and a waiting generation behind at the dispatch checkpoint", () =>
    withTempSessionsRoot(async (sessionsRoot) =>
      withTempSessionsRoot(async (snapshotRoot) => {
        const { submissionId, dispatch } = await crashAtDispatch(sessionsRoot, snapshotRoot);
        const { harness, root, inspection } = await openRecovered(snapshotRoot, []);

        // inspect() ran inside openRootConversation: it writes nothing and ran no task code.
        expect(inspection.scheduling).toBe("paused");
        expect(inspection.submissions.map((record) => [record.id, record.status])).toEqual([[submissionId, "placed"]]);

        const byKind = Object.fromEntries(inspection.tasks.map((task) => [task.record.kind, task]));
        expect(Object.keys(byKind).sort()).toEqual(["pi.generation", "pi.tool"]);
        // The task the dispatch checkpoint announced is the one inspect() reports.
        expect(String(byKind["pi.tool"]?.record.id)).toBe(dispatch?.taskId);
        expect(byKind["pi.tool"]?.state.kind).toBe("ready");
        expect(byKind["pi.generation"]?.state.kind).toBe("waiting");

        // Durable at the checkpoint: the prompt, the prompt/tool preamble and the assistant's tool call.
        // Not durable: the tool's result.
        expect((await listEntries(root, ctx)).map((entry) => entry.kind)).toEqual(["pi.user", "pi.system", "pi.assistant"]);

        await harness.close(ctx);
      }),
    ));

  it("resume() settles the submission without rerunning the interrupted tool or appending a prompt", () =>
    withTempSessionsRoot(async (sessionsRoot) =>
      withTempSessionsRoot(async (snapshotRoot) => {
        const { submissionId } = await crashAtDispatch(sessionsRoot, snapshotRoot);
        const { harness, root, inspection, executions } = await openRecovered(snapshotRoot, [
          fauxAssistantMessage("The lookup was interrupted, so I cannot report the events."),
        ]);
        const before = await listEntries(root, ctx);

        harness.resume();
        const settled = await (await harness.submission(submissionId, ctx))?.wait(ctx);
        expect(inspection.submissions).toHaveLength(1);
        expect(settled?.status).toBe("done");

        const after = await listEntries(root, ctx);
        expect(after.map((entry) => entry.kind)).toEqual([
          "pi.user",
          "pi.system",
          "pi.assistant",
          "pi.tool-result",
          "pi.assistant",
        ]);
        // Recovery added exactly the tool result and the final answer: the first three entries are untouched.
        expect(after.slice(0, before.length).map((entry) => entry.id)).toEqual(before.map((entry) => entry.id));
        expect(after.filter((entry) => entry.kind === "pi.user")).toHaveLength(1);

        // The interrupted call was not run again (replay is `unsafe` by default); the model got an error result.
        expect(executions).toEqual([]);
        const toolResult = after.find((entry) => entry.kind === "pi.tool-result")?.model?.[0];
        expect(toolResult?.role === "toolResult" && toolResult.isError).toBe(true);
        expect(JSON.stringify(toolResult)).toMatch(/interrupt/i);

        expect(settled && "answer" in settled ? settled.answer : undefined).toBe(after.at(-1)?.id);
        await harness.close(ctx);
      }),
    ));

  it("re-reading a settled submission returns its stored record and runs nothing", () =>
    withTempSessionsRoot(async (sessionsRoot) =>
      withTempSessionsRoot(async (snapshotRoot) => {
        const { submissionId } = await crashAtDispatch(sessionsRoot, snapshotRoot);
        const { harness, root, executions, faux } = await openRecovered(snapshotRoot, [
          fauxAssistantMessage("The lookup was interrupted."),
        ]);

        harness.resume();
        const first = await (await harness.submission(submissionId, ctx))?.wait(ctx);
        const entriesAfterFirst = await listEntries(root, ctx);

        // Nothing is left to recover, and asking again must not change that.
        harness.resume();
        expect(await harness.inspect(ctx)).toMatchObject({ tasks: [], submissions: [] });
        const second = await (await harness.submission(submissionId, ctx))?.wait(ctx);

        expect(second).toEqual(first);
        expect(await listEntries(root, ctx)).toEqual(entriesAfterFirst);
        expect(executions).toEqual([]);
        expect(faux.state.callCount).toBe(1);
        await harness.close(ctx);
      }),
    ));

  it("traces the resumed run as a tree whose spans began before the restart", () =>
    withTempSessionsRoot(async (sessionsRoot) =>
      withTempSessionsRoot(async (snapshotRoot) => {
        const { submissionId } = await crashAtDispatch(sessionsRoot, snapshotRoot);
        const { harness } = await openRecovered(snapshotRoot, [fauxAssistantMessage("The lookup was interrupted.")]);

        const lines: string[] = [];
        const trace = await attachTraceLogger(harness, (await harness.root(ctx)).id, (line) => lines.push(line), ctx);
        harness.resume();
        const settled = await (await harness.submission(submissionId, ctx))?.wait(ctx);
        await trace.settled(submissionId);
        await trace.stop();
        expect(settled?.status).toBe("done");

        const normalized = lines.map((line) => line.replace(/entry=\d+/g, "entry=N").replace(/inputs=\[\d+\]/g, "inputs=[N]"));
        expect(normalized).toEqual([
          "↺ ▶ run (began before the restart)",
          "  ↺ ▶ turn #1 (began before the restart)",
          "    ◀ tool_end get_container_events status=error ↺ no tool_start in this process: the call was running when the previous process died",
          "    toolResult get_container_events status=error entry=N",
          "  ◀ turn_end #1 tool_results=1",
          "  ▶ turn #2",
          "    [Assistant] entry=N The lookup was interrupted.",
          "  ◀ turn_end #2 tool_results=0",
          "◀ run_end inputs=[N]",
        ]);
        // The interrupted call has no `▶ tool_start` here: recovery resolved it, it did not run it.
        expect(normalized.some((line) => line.includes("▶ tool_start"))).toBe(false);
        await harness.close(ctx);
      }),
    ));
});

