import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { createApp } from "../src/app.js";
import type { AuthFailureReason } from "../src/authenticator.js";
import type { ChatServiceOptions } from "../src/chat-service.js";
import { PrincipalDirectory, loadTenantFixture } from "../src/directory.js";
import { signTestToken, type TokenSpec } from "../src/token-issuer.js";

export type Response = { status: number; body: Record<string, any> };
export type Step = ReturnType<typeof fauxAssistantMessage>;

export const NOW = new Date("2026-09-20T00:00:00Z");

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

export interface ProviderMessage {
  role: string;
  content: unknown;
  toolsAdded?: Array<{ name: string }>;
  toolsRemoved?: Array<{ name: string }>;
}

export interface Harness {
  baseUrl: string;
  dir: string;
  sessionsRoot: string;
  app: Awaited<ReturnType<typeof createApp>>;
  directory: PrincipalDirectory;
  faux: ReturnType<typeof fauxProvider>;
  /** Provider request payloads (serialized messages), one entry per model call, in call order. */
  providerRequests: string[];
  /** The parsed message list of each provider request, in call order. */
  providerMessages: ProviderMessage[][];
  /** One line per committed event of every chat run, as the tracer rendered it (tagged per request). */
  traceLines: string[];
  /** Hook failures the harness swallowed instead of failing a call. A healthy run leaves this empty. */
  reports: unknown[];
  authFailures: AuthFailureReason[];
  runFailures: string[];
  token(spec: TokenSpec): Promise<string>;
  as(tenant: string, subject: string): {
    chat(message: string, sessionId?: string): Promise<Response>;
    history(sessionId: string): Promise<Response>;
    compact(sessionId: string): Promise<Response>;
  };
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  script(steps: Step[], options?: { delayMs?: number }): void;
  /** Every byte of every session file written so far, for "did X reach durable state" checks. */
  sessionFilesText(): Promise<string>;
  close(): Promise<void>;
}

let callCounter = 0;
export const toolCall = (name: string, args: Record<string, unknown>, id?: string) =>
  fauxAssistantMessage(fauxToolCall(name, args as never, { id: id ?? `call-${(callCounter += 1)}` }), { stopReason: "toolUse" });
export const say = (text: string) => fauxAssistantMessage(text);

/** One tool call, then a final answer. */
export const callThenAnswer = (name: string, args: Record<string, unknown>, answer: string, id = "call-1"): Step[] => [toolCall(name, args, id), say(answer)];

/** Provider-request text as one string per message, for "where did this text appear" assertions. */
export function messageTexts(messages: ProviderMessage[]): Array<{ role: string; text: string }> {
  return messages.map((message) => ({
    role: message.role,
    text: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
  }));
}

export interface StartOptions {
  now?: Date;
  contextWindow?: number;
  compaction?: ChatServiceOptions["compaction"];
}

/** Compaction settings small enough that a short seeded conversation crosses a real cut point. */
export const SMALL_COMPACTION = { enabled: false, backgroundTokens: 0, keepRecentTokens: 60, reserveTokens: 300 } as const;

export async function startHarness(options: StartOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-19-"));
  const sessionsRoot = join(dir, "sessions");
  const directory = new PrincipalDirectory(loadTenantFixture().principals);

  const faux = fauxProvider(options.contextWindow === undefined ? undefined : { models: [{ id: "faux-small", contextWindow: options.contextWindow }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const providerRequests: string[] = [];
  const providerMessages: ProviderMessage[][] = [];
  const traceLines: string[] = [];
  const reports: unknown[] = [];
  const authFailures: AuthFailureReason[] = [];
  const runFailures: string[] = [];

  const app = await createApp({
    binding: { models, selection: { provider: faux.getModel().provider, modelId: faux.getModel().id } },
    paths: { sessionsRoot, registryPath: join(dir, "registry.jsonl") },
    issuerKeysPath: join(dir, "issuer-keys.json"),
    directory,
    clock: () => options.now ?? NOW,
    compaction: options.compaction ?? SMALL_COMPACTION,
    trace: (line) => traceLines.push(line),
    onReport: (error) => reports.push(error),
    onAuthFailure: (reason) => authFailures.push(reason),
    onRunFailure: (detail) => runFailures.push(detail),
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  const harness: Harness = {
    baseUrl,
    dir,
    sessionsRoot,
    app,
    directory,
    faux,
    providerRequests,
    providerMessages,
    traceLines,
    reports,
    authFailures,
    runFailures,
    token: (spec) => signTestToken(app.keys.privateKey, spec),
    as(tenant, subject) {
      const headers = async () => ({ authorization: `Bearer ${await harness.token({ tid: tenant, sub: subject })}` });
      return {
        chat: async (message, sessionId) => call("POST", "/v1/chat", sessionId ? { message, sessionId } : { message }, await headers()),
        history: async (sessionId) => call("GET", `/v1/sessions/${sessionId}/messages`, undefined, await headers()),
        compact: async (sessionId) => call("POST", `/v1/sessions/${sessionId}/compact`, {}, await headers()),
      };
    },
    post: (path, body, headers) => call("POST", path, body, headers),
    script(steps, scriptOptions) {
      faux.setResponses(
        steps.map((step) => async (context: { messages: unknown }) => {
          providerRequests.push(JSON.stringify(context.messages));
          providerMessages.push(JSON.parse(JSON.stringify(context.messages)) as ProviderMessage[]);
          // A slow model keeps a run in flight, so a second request genuinely overlaps it.
          if (scriptOptions?.delayMs) await new Promise((resolve) => setTimeout(resolve, scriptOptions.delayMs));
          return step;
        }),
      );
    },
    async sessionFilesText() {
      const names = (await readdir(sessionsRoot, { recursive: true, withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile());
      const parts = await Promise.all(names.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")));
      return parts.join("\n");
    },
    async close() {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

export interface Occurrence {
  requestIndex: number;
  role: string;
  /** True when the needle sits between an `<external_content` open tag and its `</external_content>` close in that message. */
  insideEnvelope: boolean;
}

/** Every place `needle` appears across all provider requests, by message role and envelope position. */
export function whereInRequests(providerMessages: Harness["providerMessages"], needle: string): Occurrence[] {
  const found: Occurrence[] = [];
  providerMessages.forEach((messages, requestIndex) => {
    for (const { role, text } of messageTexts(messages)) {
      const at = text.indexOf(needle);
      if (at < 0) continue;
      const open = text.lastIndexOf("<external_content", at);
      const close = text.indexOf("</external_content>", at);
      found.push({ requestIndex, role, insideEnvelope: open >= 0 && close >= 0 });
    }
  });
  return found;
}

export const BASELINE_OPERATOR_TOOLS = ["search_documents", "read_document", "propose_booking_status_change", "send_status_update"];
export const BASELINE_READER_TOOLS = ["search_documents", "read_document"];

/** The most recently registered session ID, for cases where the failed response did not return one. */
export async function lastSessionId(h: Harness): Promise<string> {
  const lines = (await readFile(join(h.dir, "registry.jsonl"), "utf8")).trim().split("\n");
  return (JSON.parse(lines[lines.length - 1] ?? "{}") as { sessionId: string }).sessionId;
}
