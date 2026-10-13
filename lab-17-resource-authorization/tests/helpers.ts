import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";

import { createApp, type App, type AppOptions } from "../src/app.js";
import { readAuditLog, type AuditRecord } from "../src/audit-log.js";
import { createBookingRegistry, type ModelBinding } from "../src/create-harness.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { mintSecurityContextForTest, type SecurityContext } from "../src/security-context.js";
import { entryDiagnostics, listEntries } from "../src/transcript.js";

export interface ProviderRequest {
  /** Serialized messages the provider was sent — the thing "never reached the provider" is asserted against. */
  messages: string;
  /**
   * The tools the model was offered on that call, folded from the transcript's system messages:
   * Pi 1.1 carries tool declarations as `toolsAdded` / `toolsRemoved` on those messages, and the request
   * has no `tools` field. An empty list here would make every "not offered" assertion pass vacuously,
   * so `offeredToolsOf` is itself tested (`tests/helpers.test.ts`).
   */
  offered: string[];
}

/** Net tool offer of a transcript: each system message adds and removes tools in order. */
export function offeredToolsOf(messages: ReadonlyArray<{ role: string; toolsAdded?: Array<{ name: string }>; toolsRemoved?: Array<{ name: string }> }>): string[] {
  const offered: string[] = [];
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) if (!offered.includes(tool.name)) offered.push(tool.name);
    for (const tool of message.toolsRemoved ?? []) {
      const at = offered.indexOf(tool.name);
      if (at >= 0) offered.splice(at, 1);
    }
  }
  return offered;
}

export interface ToolResultRecord {
  toolName: string;
  isError: boolean;
  /** Machine-readable reason the harness recorded for an error result (`tool_unavailable`, `invalid_arguments`, `tool_error`, `interrupted`, …). */
  code: string | undefined;
  text: string;
}

export interface TestRuntime {
  app: App;
  binding: ModelBinding;
  dir: string;
  faux: ReturnType<typeof fauxProvider>;
  providerRequests: ProviderRequest[];
  /** Every trace line the app rendered, in order. */
  trace: string[];
  /** Failures the harness swallowed instead of failing a call. */
  reports: unknown[];
  /** Queue scripted model responses; each also records the provider request it answered. */
  script(steps: Array<ReturnType<typeof fauxAssistantMessage>>): void;
  as(subject: string, tenantId?: string): SecurityContext;
  audit(): Promise<AuditRecord[]>;
  /** Tool-result entries durably stored in a session, oldest first, with their diagnostic codes. */
  toolResults(security: SecurityContext, sessionId: string): Promise<ToolResultRecord[]>;
  /** Everything persisted under the data directory, concatenated, for "this secret is nowhere on disk" assertions. */
  persistedText(): Promise<string>;
  close(): Promise<void>;
}

export async function startRuntime(overrides: Partial<AppOptions> & { dir?: string } = {}): Promise<TestRuntime> {
  const dir = overrides.dir ?? (await mkdtemp(join(tmpdir(), "pi-lab-17-")));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const providerRequests: ProviderRequest[] = [];
  const trace: string[] = [];
  const reports: unknown[] = [];

  const binding: ModelBinding = { models, selection: { provider: model.provider, modelId: model.id } };
  const app = await createApp({ binding, dataDir: dir, trace: (line) => trace.push(line), onReport: (error) => reports.push(error), ...overrides });
  let counter = 0;

  return {
    app,
    binding,
    dir,
    faux,
    providerRequests,
    trace,
    reports,
    script(steps) {
      faux.setResponses(
        steps.map((step) => (context) => {
          providerRequests.push({ messages: JSON.stringify(context.messages), offered: offeredToolsOf(context.messages as never) });
          return step;
        }),
      );
    },
    as(subject, tenantId = "tenant-a") {
      counter += 1;
      return mintSecurityContextForTest({ tenantId, subject, requestId: `req-${counter}` });
    },
    audit: () => readAuditLog(app.paths.auditPath),
    async toolResults(security, sessionId) {
      const { storage } = await openSessionStorage(app.paths.sessionsRoot, security.tenantId, sessionId, BACKGROUND_CONTEXT);
      const booking = createBookingRegistry({ security, bookings: app.bookings });
      const harness = await Harness.open(storage, { models, registry: booking.registry, settings: { compaction: { enabled: false, backgroundTokens: 0 } } }, BACKGROUND_CONTEXT);
      try {
        await harness.inspect(BACKGROUND_CONTEXT);
        const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: binding.selection } });
        return (await listEntries(root, BACKGROUND_CONTEXT)).flatMap((entry) => {
          const message = entry.model?.[0];
          if (message?.role !== "toolResult") return [];
          const code = entryDiagnostics(entry).find((diagnostic) => diagnostic.severity === "error")?.code;
          return [{ toolName: message.toolName, isError: message.isError, code, text: message.content.map((block) => (block.type === "text" ? block.text : "")).join("") }];
        });
      } finally {
        await harness.close(BACKGROUND_CONTEXT);
      }
    },
    async persistedText() {
      const names = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
      const parts = await Promise.all(names.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")));
      return parts.join("\n");
    },
    async close() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const readThenAnswer = (bookingNo: string, answer: string) => [
  fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo }), { stopReason: "toolUse" }),
  fauxAssistantMessage(answer),
];

export const updateThenAnswer = (args: Record<string, string>, answer: string) => [
  fauxAssistantMessage(fauxToolCall("update_booking_status", args), { stopReason: "toolUse" }),
  fauxAssistantMessage(answer),
];

/** Text of every tool result present in one recorded provider request, in order. */
export function toolResultTexts(request: ProviderRequest | undefined): string[] {
  const messages = JSON.parse(request?.messages ?? "[]") as Array<{ role: string; content: Array<{ text?: string }> }>;
  return messages.filter((message) => message.role === "toolResult").map((message) => message.content.map((block) => block.text ?? "").join(""));
}

/**
 * Runs `scripts/crash-child.ts` in a real child process, waits for it to announce that its tool call was
 * authorized and is about to take effect, and kills it with SIGKILL. What is left on disk is exactly what a
 * crashed process leaves: a durable run with a tool call in flight.
 */
export async function crashChildMidTool(tool: "get_booking" | "update_booking_status"): Promise<{ dir: string; sessionId: string }> {
  const workDir = await mkdtemp(join(tmpdir(), "pi-lab-17-crash-"));
  const child = spawn("node", ["--import", "tsx", "scripts/crash-child.ts", workDir, tool], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("[Checkpoint] authorized_before_effect")) resolve();
    });
    child.on("exit", () => reject(new Error("child exited before reaching its checkpoint")));
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  child.kill("SIGKILL");
  await exited;

  const [record] = (await readFile(join(workDir, "registry.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sessionId: string });
  return { dir: workDir, sessionId: (record as { sessionId: string }).sessionId };
}

export { BACKGROUND_CONTEXT, fauxAssistantMessage, fauxToolCall };
