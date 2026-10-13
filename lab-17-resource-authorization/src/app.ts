import { join } from "node:path";

import type { CryptoKey } from "jose";

import { AuditLog, createFileAuditLog } from "./audit-log.js";
import { BookingConnector, HttpBookingConnector } from "./booking-connector.js";
import { BookingService } from "./booking-service.js";
import { BookingStore, type Booking } from "./booking-store.js";
import { ChatService } from "./chat-service.js";
import { assertModelAvailable, type ModelBinding } from "./create-harness.js";
import {
  LocalDelegatedTokenProvider,
  SCOPE_READ,
  SCOPE_WRITE,
  generateDelegationKeys,
  type DelegatedTokenProvider,
} from "./delegation.js";
import { PermissionDirectory, loadDirectoryFixture } from "./directory.js";
import { DownstreamBookingService } from "./downstream-service.js";
import { PolicyDecisionService } from "./policy-service.js";
import type { TraceWriter } from "./harness-trace-logger.js";
import { SessionAccessService } from "./session-access.js";
import { SessionRegistry } from "./session-registry.js";

export interface AppOptions {
  binding: ModelBinding;
  /** Directory holding `sessions/`, `registry.jsonl`, and `audit.jsonl`. */
  dataDir: string;
  /** Override booking rows (default: the fixture). */
  bookings?: readonly Booking[];
  /** Override the audit sink (default: append to `<dataDir>/audit.jsonl`). */
  audit?: AuditLog;
  /** Scopes the simulated user has consented to for the assistant. Default: read + write. */
  consentedScopes?: readonly string[];
  /** Test switches for the credential the connector obtains. */
  tokenOverrides?: { omitActor?: boolean; expiresInSeconds?: number };
  /** Test switches for what the connector asks for. */
  connectorOverrides?: { audience?: string; scopes?: readonly string[] };
  /** Replace the connector entirely (crash/race experiments). */
  connector?: (deps: { baseUrl: string; tokens: DelegatedTokenProvider }) => BookingConnector;
  afterAuthorization?: (info: { action: string; bookingNo: string }) => Promise<void>;
  /** Render every operation's committed events as a trace tree through this writer. */
  trace?: TraceWriter;
  /** Receives failures the harness swallowed instead of failing a call. */
  onReport?: (error: unknown) => void;
  /** When false, no downstream HTTP server is started (read-only experiments). Default true. */
  startDownstream?: boolean;
}

export interface App {
  chat: ChatService;
  bookings: BookingService;
  policy: PolicyDecisionService;
  directory: PermissionDirectory;
  store: BookingStore;
  downstream: DownstreamBookingService;
  audit: AuditLog;
  paths: { sessionsRoot: string; registryPath: string; auditPath: string };
  keys: { privateKey: CryptoKey; publicKey: CryptoKey };
  close(): Promise<void>;
}

/**
 * Composition root. Everything a request needs is built here from server-side state: the
 * permission directory, the booking store (application sees only its read interface), the audit
 * log, the local downstream service, and the connector that alone holds credential access.
 */
export async function createApp(options: AppOptions): Promise<App> {
  // First, before anything is started or written: an unknown model fails here, not inside a request after a
  // session record exists, and not after the downstream server is already listening.
  assertModelAvailable(options.binding.models, options.binding.selection);

  const fixture = loadDirectoryFixture();
  const store = new BookingStore(options.bookings ?? fixture.bookings);
  const directory = new PermissionDirectory(fixture.principals);

  const paths = {
    sessionsRoot: join(options.dataDir, "sessions"),
    registryPath: join(options.dataDir, "registry.jsonl"),
    auditPath: join(options.dataDir, "audit.jsonl"),
  };
  const audit = options.audit ?? createFileAuditLog(paths.auditPath);

  const keys = await generateDelegationKeys();
  const downstream = new DownstreamBookingService({ store, publicKey: keys.publicKey });
  const baseUrl = options.startDownstream === false ? "http://127.0.0.1:0" : await downstream.listen();

  const tokens = new LocalDelegatedTokenProvider({
    privateKey: keys.privateKey,
    consentedScopes: options.consentedScopes ?? [SCOPE_READ, SCOPE_WRITE],
    ...options.tokenOverrides,
  });
  const connector = options.connector?.({ baseUrl, tokens }) ?? new HttpBookingConnector({ baseUrl, tokens, ...options.connectorOverrides });

  const policy = new PolicyDecisionService(directory, store, audit);
  const bookings = new BookingService({ policy, reader: store, connector, afterAuthorization: options.afterAuthorization });
  const sessions = new SessionAccessService(new SessionRegistry(paths.registryPath), paths.sessionsRoot);
  const chat = new ChatService({ sessions, binding: options.binding, directory, audit, bookings, trace: options.trace, onReport: options.onReport });

  return {
    chat,
    bookings,
    policy,
    directory,
    store,
    downstream,
    audit,
    paths,
    keys,
    async close() {
      if (options.startDownstream !== false) await downstream.close();
    },
  };
}
