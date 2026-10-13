import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { createApp, type CreateAppOptions } from "../src/app.js";
import type { AuthFailureReason } from "../src/authenticator.js";
import { AttemptTrace } from "../src/connector/trace.js";
import { Deadline } from "../src/connector/deadline.js";
import { UNLIMITED_BUDGET, type AttemptBudget } from "../src/connector/errors.js";
import { HttpBookingConnector, DEFAULT_RETRY, type CallScope, type RetryConfig } from "../src/connector/http-connector.js";
import { FakeBookingApi } from "../src/fake-api/server.js";
import type { RunOutcome } from "../src/http-server.js";
import { mintSecurityContextForTest, type SecurityContext } from "../src/security-context.js";
import { signTestToken, type TokenSpec } from "../src/token-issuer.js";

export type Response = { status: number; body: Record<string, any>; headers: Headers };
export type Step = ReturnType<typeof fauxAssistantMessage>;

/** The business clock for every test: cutoffs and freshness are computed against this instant. */
export const NOW = new Date("2026-09-20T00:00:00Z");

/** The five containers of tenant-a's BK1001, in listing order. */
export const BK1001_CONTAINERS = ["MSKU0000001", "MSKU0000002", "MSKU0000003", "MSKU0000004", "MSKU0000005"];

/** Retry settings small enough that real-time tests (hangs, aborts) finish quickly. */
export const FAST_RETRY: RetryConfig = { ...DEFAULT_RETRY, baseDelayMs: 10, maxDelayMs: 40, attemptTimeoutMs: 400, maxTotalWaitMs: 10_000, maxRetryAfterMs: 5_000 };

export const toolCall = (name: string, args: Record<string, unknown>, id?: string) =>
  fauxAssistantMessage([fauxToolCall(name, args as never, id === undefined ? undefined : { id })], { stopReason: "toolUse" });
export const say = (text: string) => fauxAssistantMessage(fauxText(text));
export const lookup = (bookingNo: string) => toolCall("lookup_booking", { bookingNo });
export const callThenAnswer = (bookingNo: string, answer: string): Step[] => [lookup(bookingNo), say(answer)];

export const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `condition` holds, so a test waits for an effect without a fixed sleep. */
export async function eventually(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await sleepMs(10);
  }
}

type ProviderContext = { messages: Array<{ role: string; content: unknown }> };

export interface ProviderCall {
  messages: Array<{ role: string; content: unknown }>;
  options: SimpleStreamOptions | undefined;
  model: Model<string>;
}

export interface Harness {
  baseUrl: string;
  dir: string;
  api: FakeBookingApi;
  app: Awaited<ReturnType<typeof createApp>>;
  faux: ReturnType<typeof fauxProvider>;
  /** One entry per model call, in call order. */
  providerCalls: ProviderCall[];
  /** One line per committed event of every chat run, as the tracer rendered it (tagged per request). */
  traceLines: string[];
  /** Hook failures the harness swallowed. */
  reports: unknown[];
  /** Backoff / Retry-After waits the connector asked for. The default sleep records them and returns at once. */
  sleeps: number[];
  outcomes: Array<{ outcome: RunOutcome; requestId: string }>;
  authFailures: AuthFailureReason[];
  runFailures: string[];
  token(spec: TokenSpec): Promise<string>;
  as(tenant: string, subject: string): {
    chat(message: string, options?: { sessionId?: string; signal?: AbortSignal }): Promise<Response>;
  };
  postRaw(headers: Record<string, string>, body: unknown): Promise<Response>;
  script(steps: Array<Step | ((context: ProviderContext, options: SimpleStreamOptions | undefined, model: Model<string>) => Step | Promise<Step>)>): void;
  /** Text of every tool-result message the model saw in the provider request with this index. */
  toolResultsIn(callIndex: number): string[];
  close(): Promise<void>;
}

export interface HarnessOptions {
  app?: Partial<Omit<CreateAppOptions, "connector">> & { connector?: Partial<CreateAppOptions["connector"]> };
  /** Use real timers for connector waits (needed when a test aborts during a backoff). */
  realSleep?: boolean;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-20-"));
  const api = new FakeBookingApi({ clock: () => NOW });
  const apiUrl = await api.start();

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const providerCalls: ProviderCall[] = [];
  const sleeps: number[] = [];
  const outcomes: Harness["outcomes"] = [];
  const traceLines: string[] = [];
  const reports: unknown[] = [];
  const authFailures: AuthFailureReason[] = [];
  const runFailures: string[] = [];

  const { connector: connectorOverrides, ...appOverrides } = options.app ?? {};
  const app = await createApp({
    binding: { models, selection: { provider: faux.getModel().provider, modelId: faux.getModel().id } },
    paths: { sessionsRoot: join(dir, "sessions"), registryPath: join(dir, "registry.jsonl") },
    issuerKeysPath: join(dir, "issuer-keys.json"),
    clock: () => NOW,
    ...appOverrides,
    connector: {
      baseUrl: apiUrl,
      pageSize: 2,
      retry: FAST_RETRY,
      sleep: options.realSleep
        ? undefined
        : async (ms) => {
            sleeps.push(ms);
          },
      ...connectorOverrides,
    },
    modelCall: appOverrides.modelCall ?? { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 }, requestTimeoutMs: 5_000 },
    trace: (line) => traceLines.push(line),
    onReport: (error) => reports.push(error),
    onAuthFailure: (reason) => authFailures.push(reason),
    onRunFailure: (detail) => runFailures.push(detail),
    onRunOutcome: (outcome, requestId) => outcomes.push({ outcome, requestId }),
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  async function post(headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(`${baseUrl}/v1/chat`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
    return { status: response.status, body: (await response.json()) as Record<string, any>, headers: response.headers };
  }

  const harness: Harness = {
    baseUrl,
    dir,
    api,
    app,
    faux,
    providerCalls,
    sleeps,
    traceLines,
    reports,
    outcomes,
    authFailures,
    runFailures,
    token: (spec) => signTestToken(app.keys.privateKey, spec),
    as(tenant, subject) {
      return {
        chat: async (message, chatOptions = {}) =>
          post({ authorization: `Bearer ${await harness.token({ tid: tenant, sub: subject })}` }, chatOptions.sessionId ? { message, sessionId: chatOptions.sessionId } : { message }, chatOptions.signal),
      };
    },
    postRaw: (headers, body) => post(headers, body),
    script(steps) {
      faux.setResponses(
        steps.map((step) => (context: ProviderContext, streamOptions: SimpleStreamOptions | undefined, _state: unknown, model: Model<string>) => {
          providerCalls.push({ messages: JSON.parse(JSON.stringify(context.messages)), options: streamOptions, model });
          return typeof step === "function" ? step(context, streamOptions, model) : step;
        }),
      );
    },
    toolResultsIn(callIndex) {
      return (providerCalls[callIndex]?.messages ?? [])
        .filter((message) => message.role === "toolResult")
        .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)));
    },
    async close() {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      await api.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

// --- direct connector tests (no Pi, no HTTP front door) -------------------------------------------

export const contextFor = (tenantId = "tenant-a", subject = "alice"): SecurityContext => mintSecurityContextForTest({ tenantId, subject, requestId: "req-test" });

export interface ScopeOptions {
  cancel?: AbortSignal;
  deadlineMs?: number;
  budget?: AttemptBudget;
  toolCallId?: string;
  trace?: AttemptTrace;
}

export function scopeFor(options: ScopeOptions = {}): CallScope {
  return {
    cancel: options.cancel ?? new AbortController().signal,
    deadline: Deadline.after(options.deadlineMs ?? 10_000),
    budget: options.budget ?? UNLIMITED_BUDGET,
    trace: options.trace ?? new AttemptTrace(),
    requestId: "req-test",
    toolCallId: options.toolCallId ?? "tool-1",
  };
}

export interface ConnectorRig {
  api: FakeBookingApi;
  connector: HttpBookingConnector;
  sleeps: number[];
  close(): Promise<void>;
}

export async function startConnector(overrides: { retry?: Partial<RetryConfig>; pageSize?: number; maxPagesPerLookup?: number; credential?: string; realSleep?: boolean; maxResponseBytes?: number } = {}): Promise<ConnectorRig> {
  const api = new FakeBookingApi({ clock: () => NOW });
  const baseUrl = await api.start();
  const sleeps: number[] = [];
  const { realSleep } = await import("../src/connector/http-connector.js");
  const connector = new HttpBookingConnector({
    baseUrl,
    credential: () => overrides.credential ?? "svc-lab20-full",
    pageSize: overrides.pageSize ?? 2,
    maxPagesPerLookup: overrides.maxPagesPerLookup ?? 10,
    maxResponseBytes: overrides.maxResponseBytes ?? 64 * 1024,
    retry: { ...FAST_RETRY, ...overrides.retry },
    clock: () => NOW,
    sleep: overrides.realSleep
      ? realSleep
      : async (ms) => {
          sleeps.push(ms);
        },
  });
  return { api, connector, sleeps, close: () => api.close() };
}
