import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { createApp } from "../src/app.js";
import { type Booking, TenantBookingStore } from "../src/booking-store.js";
import { loadTenantFixture } from "../src/directory.js";
import { createRequestRegistry, openHarness } from "../src/create-harness.js";
import { mintSecurityContextForTest, type SecurityContext } from "../src/security-context.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import type { AuthFailureReason } from "../src/authenticator.js";
import { signTestToken, type TokenSpec } from "../src/token-issuer.js";

export interface Harness {
  baseUrl: string;
  dir: string;
  sessionsRoot: string;
  registryPath: string;
  app: Awaited<ReturnType<typeof createApp>>;
  faux: ReturnType<typeof fauxProvider>;
  /** Provider request payloads (serialized messages), one entry per model call, in call order. */
  providerRequests: string[];
  authFailures: AuthFailureReason[];
  runFailures: string[];
  /** Every line the per-request tracer wrote, across all requests. */
  traceLines: string[];
  /** Hook failures the harness swallowed. */
  reports: unknown[];
  token(spec: TokenSpec): Promise<string>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }>;
  get(path: string, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Queue scripted model responses; each also records the provider request it answered. */
  script(steps: Array<ReturnType<typeof fauxAssistantMessage>>): void;
  close(): Promise<void>;
}

export const lookupThenAnswer = (bookingNo: string, answer: string, extraArgs: Record<string, string> = {}) => [
  fauxAssistantMessage([fauxToolCall("get_booking", { bookingNo, ...extraArgs })], { stopReason: "toolUse" }),
  fauxAssistantMessage(fauxText(answer)),
];

export async function startHarness(options: { traceText?: "redacted" | "full"; store?: TenantBookingStore } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-16-"));
  const sessionsRoot = join(dir, "sessions");
  const registryPath = join(dir, "registry.jsonl");

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);

  const providerRequests: string[] = [];
  const authFailures: AuthFailureReason[] = [];
  const runFailures: string[] = [];
  const traceLines: string[] = [];
  const reports: unknown[] = [];

  const app = await createApp({
    binding: { models, selection: { provider: faux.getModel().provider, modelId: faux.getModel().id } },
    paths: { sessionsRoot, registryPath },
    issuerKeysPath: join(dir, "issuer-keys.json"),
    onAuthFailure: (reason) => authFailures.push(reason),
    onRunFailure: (detail) => runFailures.push(detail),
    trace: (line) => traceLines.push(line),
    traceText: options.traceText,
    onReport: (error) => reports.push(error),
    store: options.store,
  });

  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  return {
    baseUrl,
    dir,
    sessionsRoot,
    registryPath,
    app,
    faux,
    providerRequests,
    authFailures,
    runFailures,
    traceLines,
    reports,
    token: (spec) => signTestToken(app.keys.privateKey, spec),
    post: (path, body, headers) => call("POST", path, body, headers),
    get: (path, headers) => call("GET", path, undefined, headers),
    script(steps) {
      faux.setResponses(
        steps.map((step) => (context: TranscriptContext) => {
          providerRequests.push(JSON.stringify(context.messages));
          return step;
        }),
      );
    },
    async close() {
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function sessionFilesOnDisk(sessionsRoot: string): Promise<string[]> {
  try {
    return (await readdir(sessionsRoot, { recursive: true })).map(String);
  } catch {
    return [];
  }
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** A store with a scoping bug: a tenant-a lookup is answered from tenant-b's rows. Only for the boundary-recorder test. */
export function leakyStore(): TenantBookingStore {
  class LeakyStore extends TenantBookingStore {
    public override findByBookingNo(_context: SecurityContext, bookingNo: string): Booking | undefined {
      return super.findByBookingNo(mintSecurityContextForTest({ tenantId: "tenant-b", subject: "carol", requestId: "bug" }), bookingNo);
    }
  }
  return new LeakyStore(loadTenantFixture().bookings);
}

/**
 * Writes one user input (answered by whatever the scripted provider returns next) straight into a session's
 * storage through a bare harness, bypassing ChatService and therefore its checks. How a test plants content
 * that a later request then finds already stored.
 */
export async function seedSession(h: Harness, tenantId: string, subject: string, sessionId: string, text: string): Promise<void> {
  const security = mintSecurityContextForTest({ tenantId, subject, requestId: "seed" });
  const { storage } = await openSessionStorage(h.sessionsRoot, tenantId, sessionId, BACKGROUND_CONTEXT);
  const { harness, root } = await openHarness(
    storage,
    {
      binding: h.app.binding,
      requestRegistry: createRequestRegistry({ securityContext: security, store: h.app.store, cache: h.app.cache }),
    },
    BACKGROUND_CONTEXT,
  );
  await (await root.submit({ type: "input", content: text }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
}
