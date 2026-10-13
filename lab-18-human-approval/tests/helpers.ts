import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { createApp } from "../src/app.js";
import type { AuthFailureReason } from "../src/authenticator.js";
import { PrincipalDirectory, loadTenantFixture } from "../src/directory.js";
import { signTestToken, type TokenSpec } from "../src/token-issuer.js";
import { FakeClock, startDb, type TestDb } from "./db-helpers.js";

type Response = { status: number; body: Record<string, any> };

export interface Harness {
  baseUrl: string;
  db: TestDb;
  clock: FakeClock;
  directory: PrincipalDirectory;
  app: Awaited<ReturnType<typeof createApp>>;
  faux: ReturnType<typeof fauxProvider>;
  /** One line per committed event of every chat run, as the tracer rendered it (tagged per request). */
  traceLines: string[];
  /** Hook failures the harness swallowed. */
  reports: unknown[];
  /** Provider request payloads (serialized messages), one entry per model call, in call order. */
  providerRequests: string[];
  authFailures: AuthFailureReason[];
  runFailures: string[];
  token(spec: TokenSpec): Promise<string>;
  /** Authenticated request as a principal; the token is minted by the local test issuer. */
  as(tenant: string, subject: string): {
    post(path: string, body?: unknown): Promise<Response>;
    get(path: string): Promise<Response>;
    chat(message: string, sessionId?: string): Promise<Response>;
  };
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  script(steps: Array<ReturnType<typeof fauxAssistantMessage>>, options?: { delayMs?: number }): void;
  /** Stops the server and builds a fresh one over the same database and session files. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export const callThenAnswer = (toolName: string, args: Record<string, unknown>, answer: string, id = "call-1") => [
  fauxAssistantMessage(fauxToolCall(toolName, args as never, { id }), { stopReason: "toolUse" }),
  fauxAssistantMessage(answer),
];

export const proposeThenAnswer = (args: Record<string, unknown>, answer: string, id = "call-1") =>
  callThenAnswer("propose_booking_status_change", args, answer, id);

/** Starts a real HTTP server over a throwaway Postgres schema and a scripted (no-network) model. */
export async function startHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-18-"));
  const db = await startDb();
  const clock = new FakeClock();
  const directory = new PrincipalDirectory(loadTenantFixture().principals);

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const providerRequests: string[] = [];
  const authFailures: AuthFailureReason[] = [];
  const runFailures: string[] = [];
  const traceLines: string[] = [];
  const reports: unknown[] = [];

  async function build() {
    const app = await createApp({
      binding: { models, selection: { provider: faux.getModel().provider, modelId: faux.getModel().id } },
      pool: db.pool,
      sessionsRoot: join(dir, "sessions"),
      registryPath: join(dir, "registry.jsonl"),
      issuerKeysPath: join(dir, "issuer-keys.json"),
      directory,
      actionOptions: { clock },
      trace: (line) => traceLines.push(line),
      onReport: (error) => reports.push(error),
      onAuthFailure: (reason) => authFailures.push(reason),
      onRunFailure: (detail) => runFailures.push(detail),
    });
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    return { app, baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
  }

  let current = await build();

  async function call(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const response = await fetch(`${current.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  const stop = () => new Promise<void>((resolve) => current.app.server.close(() => resolve()));

  const harness: Harness = {
    get baseUrl() {
      return current.baseUrl;
    },
    db,
    clock,
    directory,
    get app() {
      return current.app;
    },
    faux,
    providerRequests,
    traceLines,
    reports,
    authFailures,
    runFailures,
    token: (spec) => signTestToken(current.app.keys.privateKey, spec),
    as(tenant, subject) {
      const headers = async () => ({ authorization: `Bearer ${await harness.token({ tid: tenant, sub: subject })}` });
      return {
        post: async (path, body) => call("POST", path, body ?? {}, await headers()),
        get: async (path) => call("GET", path, undefined, await headers()),
        chat: async (message, sessionId) => call("POST", "/v1/chat", sessionId ? { message, sessionId } : { message }, await headers()),
      };
    },
    post: (path, body, headers) => call("POST", path, body, headers),
    script(steps, options) {
      faux.setResponses(
        steps.map((step) => async (context: { messages: unknown }) => {
          providerRequests.push(JSON.stringify(context.messages));
          // A slow model keeps a run in flight, so a second request genuinely overlaps it.
          if (options?.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
          return step;
        }),
      );
    },
    async restart() {
      await stop();
      current = await build();
    },
    async close() {
      await stop();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return harness;
}
