import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

import { ActionService, type ActionServiceOptions } from "./action-service.js";
import { createAuthenticator } from "./authenticator.js";
import { ChatService } from "./chat-service.js";
import { modelBindingFromEnvironment, type ModelBinding } from "./create-harness.js";
import { PrincipalDirectory, loadTenantFixture } from "./directory.js";
import type { TraceWriter } from "./harness-trace-logger.js";
import { createHttpServer } from "./http-server.js";
import { Policy } from "./policy.js";
import { SessionAccessService } from "./session-access.js";
import { SessionRegistry } from "./session-registry.js";
import { LOCAL_AUDIENCE, LOCAL_ISSUER, loadOrCreateIssuerKeys } from "./token-issuer.js";

export const SESSIONS_ROOT = fileURLToPath(new URL("../session-data/sessions", import.meta.url));
export const REGISTRY_PATH = fileURLToPath(new URL("../session-data/session-registry.jsonl", import.meta.url));
export const ISSUER_KEYS_PATH = fileURLToPath(new URL("../runtime-evidence/local-issuer-keys.json", import.meta.url));

export interface AppOptions {
  binding: ModelBinding;
  pool: Pool;
  sessionsRoot: string;
  registryPath?: string;
  issuerKeysPath?: string;
  /** Clock and TTL overrides for the action service (tests move time deterministically). */
  actionOptions?: Partial<Pick<ActionServiceOptions, "clock" | "decisionTtlMs" | "approvalTtlMs">>;
  /** Share a directory across a simulated restart so a role revoked earlier stays revoked. */
  directory?: PrincipalDirectory;
  /** One trace line per committed event of every chat run, tagged by request. */
  trace?: TraceWriter;
  onReport?: (error: unknown) => void;
  onAuthFailure?: Parameters<typeof createHttpServer>[0]["onAuthFailure"];
  onRunFailure?: Parameters<typeof createHttpServer>[0]["onRunFailure"];
}

/**
 * The composition root. Business state (bookings, actions, approvals, effects) lives in the
 * PostgreSQL `pool`; Pi sessions stay in JSONL files under `sessionsRoot`. The two stores are
 * not transactional with each other — an approval never depends on a session file.
 */
export async function createApp(options: AppOptions) {
  const fixture = loadTenantFixture();
  const keys = await loadOrCreateIssuerKeys(options.issuerKeysPath ?? ISSUER_KEYS_PATH);
  const directory = options.directory ?? new PrincipalDirectory(fixture.principals);
  const policy = new Policy(directory);
  const actions = new ActionService({ pool: options.pool, policy, ...options.actionOptions });
  const sessions = new SessionAccessService(new SessionRegistry(options.registryPath), options.sessionsRoot);
  const chat = new ChatService({ sessions, binding: options.binding, actions, trace: options.trace, onReport: options.onReport });
  const authenticate = createAuthenticator({ issuer: LOCAL_ISSUER, audience: LOCAL_AUDIENCE, publicKey: keys.publicKey, directory });
  const server = createHttpServer({ authenticate, chat, actions, onAuthFailure: options.onAuthFailure, onRunFailure: options.onRunFailure });
  return { server, keys, directory, policy, actions, chat, sessions, authenticate, binding: options.binding };
}

export { modelBindingFromEnvironment };
