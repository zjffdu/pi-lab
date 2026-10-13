import { fileURLToPath } from "node:url";

import { createAuthenticator } from "./authenticator.js";
import { type Booking, TenantBookingStore } from "./booking-store.js";
import { ChatService } from "./chat-service.js";
import { PrincipalDirectory, loadTenantFixture } from "./directory.js";
import { modelBindingFromEnvironment, type ModelBinding } from "./create-harness.js";
import type { TraceWriter } from "./harness-trace-logger.js";
import { createHttpServer } from "./http-server.js";
import { SessionAccessService } from "./session-access.js";
import { SessionRegistry } from "./session-registry.js";
import { ScopedCache } from "./scoped-cache.js";
import { LOCAL_AUDIENCE, LOCAL_ISSUER, loadOrCreateIssuerKeys } from "./token-issuer.js";

export const SESSIONS_ROOT = fileURLToPath(new URL("../session-data/sessions", import.meta.url));
export const REGISTRY_PATH = fileURLToPath(new URL("../session-data/session-registry.jsonl", import.meta.url));
export const ISSUER_KEYS_PATH = fileURLToPath(new URL("../runtime-evidence/local-issuer-keys.json", import.meta.url));

export interface AppPaths {
  sessionsRoot: string;
  registryPath?: string;
}

/**
 * The composition root: wires the validator, tenant-scoped store and cache, session registry, and
 * chat service into one HTTP server. Tests pass a scripted `binding` and temp-directory paths;
 * `index.ts` passes the real model and the default paths.
 */
export interface CreateAppOptions {
  binding: ModelBinding;
  paths: AppPaths;
  issuerKeysPath?: string;
  onAuthFailure?: Parameters<typeof createHttpServer>[0]["onAuthFailure"];
  onRunFailure?: Parameters<typeof createHttpServer>[0]["onRunFailure"];
  /** Per-request run/turn/tool trace. Omit for none. */
  trace?: TraceWriter;
  traceText?: "redacted" | "full";
  onReport?: (error: unknown) => void;
  /** Test seam: substitute the booking store (for example one with a deliberate scoping bug). */
  store?: TenantBookingStore;
}

export async function createApp(options: CreateAppOptions) {
  const fixture = loadTenantFixture();
  const keys = await loadOrCreateIssuerKeys(options.issuerKeysPath ?? ISSUER_KEYS_PATH);
  const store = options.store ?? new TenantBookingStore(fixture.bookings);
  const cache = new ScopedCache<Booking>();
  const sessions = new SessionAccessService(new SessionRegistry(options.paths.registryPath), options.paths.sessionsRoot);
  const chat = new ChatService({
    sessions,
    binding: options.binding,
    store,
    cache,
    trace: options.trace,
    traceText: options.traceText,
    onReport: options.onReport,
  });
  const authenticate = createAuthenticator({
    issuer: LOCAL_ISSUER,
    audience: LOCAL_AUDIENCE,
    publicKey: keys.publicKey,
    directory: new PrincipalDirectory(fixture.principals),
  });
  const server = createHttpServer({ authenticate, chat, onAuthFailure: options.onAuthFailure, onRunFailure: options.onRunFailure });
  return { server, keys, store, cache, sessions, chat, authenticate, binding: options.binding };
}

export { modelBindingFromEnvironment };
