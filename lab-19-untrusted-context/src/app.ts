import { fileURLToPath } from "node:url";

import { AclService } from "./acl.js";
import { createAuthenticator } from "./authenticator.js";
import { TenantBookingStore } from "./booking-store.js";
import { ChatService, type ChatServiceOptions } from "./chat-service.js";
import { modelBindingFromEnvironment, type ModelBinding } from "./create-harness.js";
import type { TraceWriter } from "./harness-trace-logger.js";
import { PrincipalDirectory, loadTenantFixture } from "./directory.js";
import { DocumentRepository } from "./document-repository.js";
import { DocumentService, RetrievalCache } from "./document-service.js";
import { createHttpServer } from "./http-server.js";
import { OutboxSink } from "./outbound-tool.js";
import { ProposalLedger } from "./proposal-ledger.js";
import { SessionAccessService } from "./session-access.js";
import { SessionRegistry } from "./session-registry.js";
import { LOCAL_AUDIENCE, LOCAL_ISSUER, loadOrCreateIssuerKeys } from "./token-issuer.js";

export const SESSIONS_ROOT = fileURLToPath(new URL("../session-data/sessions", import.meta.url));
export const REGISTRY_PATH = fileURLToPath(new URL("../session-data/session-registry.jsonl", import.meta.url));
export const ISSUER_KEYS_PATH = fileURLToPath(new URL("../runtime-evidence/local-issuer-keys.json", import.meta.url));

export interface CreateAppOptions {
  binding: ModelBinding;
  paths: { sessionsRoot: string; registryPath?: string };
  /** Compaction settings for the harness (off by default). */
  compaction?: ChatServiceOptions["compaction"];
  /** One trace line per committed event of every chat run, tagged by request. Off by default. */
  trace?: TraceWriter;
  /** Receives hook failures the harness swallowed. */
  onReport?: (error: unknown) => void;
  issuerKeysPath?: string;
  /** Tests inject a directory (to revoke roles), a clock (freshness), and hooks. */
  directory?: PrincipalDirectory;
  clock?: () => Date;
  onAuthFailure?: Parameters<typeof createHttpServer>[0]["onAuthFailure"];
  onRunFailure?: Parameters<typeof createHttpServer>[0]["onRunFailure"];
}

/**
 * The composition root. Document access, the booking store, the proposal ledger, and the outbound
 * sink are all created here and reach the model only through tools closed over the caller's
 * server-created `SecurityContext`.
 */
export async function createApp(options: CreateAppOptions) {
  const fixture = loadTenantFixture();
  const keys = await loadOrCreateIssuerKeys(options.issuerKeysPath ?? ISSUER_KEYS_PATH);
  const directory = options.directory ?? new PrincipalDirectory(fixture.principals);
  const bookings = new TenantBookingStore(fixture.bookings);
  const repository = DocumentRepository.fromDefaultFixture();
  const documents = new DocumentService({ repository, acl: new AclService(directory), cache: new RetrievalCache(), clock: options.clock });
  const ledger = new ProposalLedger(bookings, directory);
  const outbox = new OutboxSink();
  const allowed = new Map(fixture.egress.map((entry) => [entry.tenantId, entry.allowedRecipients]));

  const sessions = new SessionAccessService(new SessionRegistry(options.paths.registryPath), options.paths.sessionsRoot);
  const capabilities = { documents, bookings, ledger, outbox, directory, allowedRecipientsFor: (tenantId: string) => allowed.get(tenantId) ?? [] };
  const chat = new ChatService({ sessions, binding: options.binding, capabilities, compaction: options.compaction, trace: options.trace, onReport: options.onReport });
  const authenticate = createAuthenticator({ issuer: LOCAL_ISSUER, audience: LOCAL_AUDIENCE, publicKey: keys.publicKey, directory });
  const server = createHttpServer({ authenticate, chat, onAuthFailure: options.onAuthFailure, onRunFailure: options.onRunFailure });
  return { server, keys, directory, repository, documents, bookings, ledger, outbox, capabilities, sessions, chat, authenticate, binding: options.binding };
}

export { modelBindingFromEnvironment };
