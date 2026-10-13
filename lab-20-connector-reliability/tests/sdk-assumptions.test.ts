import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, MemoryStorage, ToolTask, watchEvents } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { assertModelAvailable, modelBindingFromEnvironment, modelSelectionFromEnvironment } from "../src/create-harness.js";
import { withOutputCap } from "../src/model-limits.js";
import { errorDiagnostic } from "../src/transcript.js";
import { sleepMs } from "./helpers.js";

/**
 * Behaviors of `@earendil-works/pi-durable` 1.1.0 this lab's design depends on, checked against the real
 * harness with a scripted provider. If one fails after an SDK upgrade, the control built on it must be
 * re-derived, not just the test updated. Timing assertions use generous margins and compare *elapsed
 * time against what the tool would have taken*, never a flag set by an abort listener: the signal also
 * fires as cleanup after `execute()` returns (see "the signal fires after execute() returns").
 */
const ctx = BACKGROUND_CONTEXT;
const params = Type.Object({ n: Type.Number() }, { additionalProperties: false });
const callTool = (id = "call-1") => fauxAssistantMessage(fauxToolCall("t", { n: 1 }, { id }), { stopReason: "toolUse" });

interface ToolLog {
  startedAt: number | undefined;
  returnedAt: number | undefined;
  signalFiredAt: number | undefined;
  /** What the signal's state was at the moment `execute()` returned. */
  abortedWhenReturning: boolean | undefined;
  callId: string | undefined;
}

function newLog(): ToolLog {
  return { startedAt: undefined, returnedAt: undefined, signalFiredAt: undefined, abortedWhenReturning: undefined, callId: undefined };
}

/** A tool that takes `ms`; with `resolveOnAbort` it returns as soon as its signal fires. */
function slowTool(log: ToolLog, ms: number, resolveOnAbort: boolean) {
  return defineTool({
    name: "t",
    description: "t",
    parameters: params,
    executionMode: "sequential",
    replay: "safe",
    async execute(_args, api, context) {
      log.startedAt = Date.now();
      log.callId = api.callId;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        context.abortSignal?.addEventListener("abort", () => {
          log.signalFiredAt ??= Date.now();
          if (resolveOnAbort) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      log.abortedWhenReturning = context.abortSignal?.aborted;
      log.returnedAt = Date.now();
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  });
}

async function rig(options: { tools?: ReturnType<typeof defineTool>[]; hooks?: ReturnType<typeof hook>[]; settings?: Record<string, unknown> } = {}) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const tools = options.tools ?? [];
  const registry = createRegistry();
  registry.install(defineExtension({ name: "x", tools, hooks: options.hooks ?? [] }));
  const reports: unknown[] = [];
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: options.settings as never, onReport: (error) => reports.push(error) }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, tools } });
  return { faux, models, harness, root, reports, close: () => harness.close(ctx) };
}

describe("cancellation seam", () => {
  it("cancelling the Context given to wait() only stops the wait: the run carries on and settles `done`", async () => {
    const log = newLog();
    const { faux, root, close } = await rig({ tools: [slowTool(log, 250, false)] });
    faux.setResponses([callTool(), fauxAssistantMessage(fauxText("answered anyway"))]);
    const submission = await root.submit({ type: "input", content: "go" }, ctx);
    while (log.startedAt === undefined) await sleepMs(5);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(submission.wait(withAbortSignal(controller.signal, ctx))).rejects.toThrow(/abort/i);

    const settled = await submission.wait(ctx);
    expect(settled.status).toBe("done");
    // The tool ran its whole 250 ms although the waiter gave up after ~20 ms.
    expect(log.returnedAt! - log.startedAt!).toBeGreaterThanOrEqual(230);
    await close();
  });

  it("root.abort() stops a running tool early: the tool sees the signal while running, and the submission settles unanswered/aborted", async () => {
    const log = newLog();
    const { faux, root, close } = await rig({ tools: [slowTool(log, 2_000, true)] });
    faux.setResponses([callTool(), fauxAssistantMessage(fauxText("never"))]);
    const submission = await root.submit({ type: "input", content: "go" }, ctx);
    while (log.startedAt === undefined) await sleepMs(5);

    await root.abort(ctx);
    const settled = await submission.wait(ctx);
    expect(settled).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(log.abortedWhenReturning).toBe(true); // the signal was already aborted when execute() came back
    expect(log.returnedAt! - log.startedAt!).toBeLessThan(1_000); // a 2 s tool did not run its 2 s
    await close();
  });

  it("the signal fires after execute() returns, as cleanup — so a listener flag alone proves nothing", async () => {
    const log = newLog();
    const { faux, root, close } = await rig({ tools: [slowTool(log, 40, false)] });
    faux.setResponses([callTool(), fauxAssistantMessage(fauxText("done"))]);
    const settled = await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    await sleepMs(50);
    expect(settled.status).toBe("done");
    expect(log.abortedWhenReturning).toBe(false); // not aborted while the tool was running
    expect(log.signalFiredAt).toBeGreaterThanOrEqual(log.returnedAt!); // ...and fired only afterwards
    await close();
  });

  it("aborting while a provider call is in flight gives the provider an aborted signal, and the submission settles aborted", async () => {
    let providerSawAbort = false;
    const { faux, root, close } = await rig();
    faux.setResponses([
      async (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
        await sleepMs(250);
        providerSawAbort = options?.signal?.aborted ?? false;
        return fauxAssistantMessage(fauxText("late"));
      },
    ]);
    const submission = await root.submit({ type: "input", content: "go" }, ctx);
    await sleepMs(40);
    await root.abort(ctx);
    expect(await submission.wait(ctx)).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(providerSawAbort).toBe(true);
    await close();
  });
});

describe("hooks the budgets use", () => {
  it("beforeTool { block } skips execute(), and the model gets an error result with diagnostic code `blocked`", async () => {
    const log = newLog();
    const { faux, root, close } = await rig({ tools: [slowTool(log, 1, false)], hooks: [hook(ToolTask, { beforeTool: () => ({ block: "BUDGET_EXHAUSTED" }) })] });
    faux.setResponses([callTool(), fauxAssistantMessage(fauxText("answered"))]);
    const settled = await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    expect(settled.status).toBe("done");
    expect(log.startedAt).toBeUndefined();
    const entries = (await root.entries({ order: "ascending" }, 100, undefined, ctx)).items;
    const result = entries.find((entry) => entry.model?.[0]?.role === "toolResult");
    expect(result?.model?.[0]).toMatchObject({ role: "toolResult", isError: true });
    expect(errorDiagnostic(result)).toMatchObject({ code: "blocked", message: expect.stringContaining("BUDGET_EXHAUSTED") });
    await close();
  });

  it("afterResponse sees every terminal provider message — including usage and a `length` stop that the stored entry no longer shows", async () => {
    const seen: Array<{ stopReason: string; totalTokens: number }> = [];
    const { faux, root, close } = await rig({ hooks: [hook(GenerationTask, { afterResponse: (message) => void seen.push({ stopReason: message.stopReason, totalTokens: message.usage.totalTokens }) })] });
    faux.setResponses([fauxAssistantMessage(fauxText("The booking is"), { stopReason: "length" })]);
    const settled = await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    expect(seen).toEqual([{ stopReason: "length", totalTokens: expect.any(Number) }]);
    expect(seen[0]!.totalTokens).toBeGreaterThan(0);
    // The run is `done` with the fragment as its answer: only the hook knows it was cut off.
    expect(settled.status).toBe("done");
    await close();
  });

  it("afterTools runs once a round's tools are done and before the next request is prepared; an abort there ends the run with no further model call", async () => {
    let calls = 0;
    let rootRef: Awaited<ReturnType<typeof rig>>["root"] | undefined;
    const { faux, root, close } = await rig({
      tools: [slowTool(newLog(), 1, false)],
      hooks: [hook(GenerationTask, { afterTools: () => void rootRef?.abort(ctx).catch(() => undefined) })],
    });
    rootRef = root;
    faux.setResponses([() => (calls++, callTool()), () => (calls++, callTool()), () => (calls++, fauxAssistantMessage(fauxText("end")))]);
    const settled = await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    expect(settled).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(calls).toBe(1); // observed; no SDK guarantee — the abort is a commit racing the next request (see README)
    await close();
  });

  it("beforeRequest can replace the messages of one request, and the provider receives the replacement", async () => {
    const received: string[] = [];
    const { faux, root, close } = await rig({
      hooks: [hook(GenerationTask, { beforeRequest: () => ({ messages: [{ role: "user", content: "WITHHELD", timestamp: 0 }] }) })],
    });
    faux.setResponses([(context: { messages: unknown }) => (received.push(JSON.stringify(context.messages)), fauxAssistantMessage(fauxText("ok")))]);
    await (await root.submit({ type: "input", content: "a secret the provider must not see" }, ctx)).wait(ctx);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("WITHHELD");
    expect(received[0]).not.toContain("a secret");
    await close();
  });
});

describe("tool identity (the trace joins on it)", () => {
  it("the model's call id, api.callId, and the event's toolCallId are the same string", async () => {
    const log = newLog();
    const { faux, root, harness, close } = await rig({ tools: [slowTool(log, 1, false)] });
    faux.setResponses([callTool("model-chosen-id"), fauxAssistantMessage(fauxText("done"))]);
    const ids: string[] = [];
    const stream = await watchEvents(harness, root.id, ctx);
    stream.start(async (events) => {
      for (const event of events) if (event.type === "tool_execution_start" || event.type === "tool_execution_end") ids.push(event.toolCallId);
    });
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    await sleepMs(50);
    expect(log.callId).toBe("model-chosen-id");
    expect(ids).toEqual(["model-chosen-id", "model-chosen-id"]);
    await stream.stop();
    await close();
  });
});

describe("model-call limits and retry ownership", () => {
  it("settings.stream and settings.retry reach the provider/harness: the SDK layer can be pinned to 0 while the harness owns the retry", async () => {
    const seen: Array<{ maxRetries: unknown; timeoutMs: unknown }> = [];
    let failures = 0;
    const failing = (_context: unknown, options: { maxRetries?: unknown; timeoutMs?: unknown } | undefined) => {
      failures++;
      seen.push({ maxRetries: options?.maxRetries, timeoutMs: options?.timeoutMs });
      return fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" });
    };
    const { faux, root, close } = await rig({ settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, stream: { maxRetries: 0, timeoutMs: 4321 } } });
    faux.setResponses([failing, failing, failing, failing]);
    const settled = await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    expect(settled).toMatchObject({ status: "unanswered", reason: "model_error", detail: "503 service unavailable" });
    expect(failures).toBe(2); // one call + one harness retry — not 1 + 3 (the default) and not multiplied by an SDK layer
    expect(seen).toEqual([
      { maxRetries: 0, timeoutMs: 4321 },
      { maxRetries: 0, timeoutMs: 4321 },
    ]);
    await close();
  });

  it("the harness retries a provider failure 3 times by default (so leaving the retry setting alone would cost 4 requests)", async () => {
    let failures = 0;
    const failing = () => (failures++, fauxAssistantMessage([], { stopReason: "error", errorMessage: "503" }));
    const { faux, root, close } = await rig({ settings: { retry: { baseDelayMs: 1 } } });
    faux.setResponses([failing, failing, failing, failing, failing]);
    await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    expect(failures).toBe(4);
    await close();
  });

  it("ConversationStreamOptions has no maxTokens: the output cap has to live on the registry's model entry, where the provider reads it", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const binding = { models, selection: { provider: faux.getModel().provider, modelId: faux.getModel().id } };

    const seen: Array<{ modelMaxTokens: number; optionMaxTokens: unknown }> = [];
    const probe = (_context: unknown, options: { maxTokens?: unknown } | undefined, _state: unknown, model: { maxTokens: number }) => (
      seen.push({ modelMaxTokens: model.maxTokens, optionMaxTokens: options?.maxTokens }),
      fauxAssistantMessage(fauxText("ok"))
    );

    for (const capped of [binding, withOutputCap(binding, 55)]) {
      faux.setResponses([probe as never]);
      const harness = await Harness.open(new MemoryStorage(), { models: capped.models, registry: createRegistry() }, ctx);
      const root = await harness.root(ctx, { agent: { model: capped.selection } });
      expect((await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx)).status).toBe("done");
      await harness.close(ctx);
    }
    expect(seen).toEqual([
      { modelMaxTokens: 16384, optionMaxTokens: undefined },
      { modelMaxTokens: 55, optionMaxTokens: undefined },
    ]);
  });

  it("the default model id resolves in the pinned catalog (deepseek-flash, not the 0.85.1 id), and withOutputCap works on the built-in entry without network access", () => {
    expect(modelSelectionFromEnvironment({})).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
    const binding = modelBindingFromEnvironment({});
    expect(() => assertModelAvailable(binding.models, binding.selection)).not.toThrow();
    expect(() => assertModelAvailable(binding.models, { provider: "deepseek", modelId: "deepseek-v4-flash" })).toThrow(/Unknown model/);
    const realMax = binding.models.getModel("deepseek", "deepseek-flash")!.maxTokens;
    expect(realMax).toBeGreaterThan(800);
    const capped = withOutputCap(binding, 800);
    expect(capped.models.getModel("deepseek", "deepseek-flash")).toMatchObject({ id: "deepseek-flash", maxTokens: 800 });
    expect(capped.models.getModels("deepseek").every((model) => model.maxTokens <= 800)).toBe(true);
  });
});
