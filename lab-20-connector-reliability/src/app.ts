import { fileURLToPath } from "node:url";

import { AdmissionQueue, type AdmissionQueueOptions } from "./admission-queue.js";
import { createAuthenticator } from "./authenticator.js";
import { ChatService } from "./chat-service.js";
import { DEFAULT_RETRY, HttpBookingConnector, type RetryConfig, type Sleep } from "./connector/http-connector.js";
import { BookingLookupService } from "./connector/lookup.js";
import { modelBindingFromEnvironment, type ModelBinding, type ModelCallConfig } from "./create-harness.js";
import type { TraceWriter } from "./harness-trace-logger.js";
import { PrincipalDirectory, loadTenantFixture } from "./directory.js";
import { FULL_ACCESS_TOKEN } from "./fake-api/server.js";
import { createHttpServer, type HttpServerOptions } from "./http-server.js";
import { DEFAULT_LIMITS, type BudgetLimits } from "./run-budget.js";
import { SessionAccessService } from "./session-access.js";
import { SessionRegistry } from "./session-registry.js";
import { LOCAL_AUDIENCE, LOCAL_ISSUER, loadOrCreateIssuerKeys } from "./token-issuer.js";
import type { Pricing } from "./usage-meter.js";

export const SESSIONS_ROOT = fileURLToPath(new URL("../session-data/sessions", import.meta.url));
export const REGISTRY_PATH = fileURLToPath(new URL("../session-data/session-registry.jsonl", import.meta.url));
export const ISSUER_KEYS_PATH = fileURLToPath(new URL("../runtime-evidence/local-issuer-keys.json", import.meta.url));

export interface CreateAppOptions {
  binding: ModelBinding;
  paths: { sessionsRoot: string; registryPath?: string };
  issuerKeysPath?: string;
  connector: {
    baseUrl: string;
    /** Defaults to the local fake API's full-access test token. It stays inside the connector. */
    credential?: () => string;
    retry?: Partial<RetryConfig>;
    pageSize?: number;
    maxPagesPerLookup?: number;
    sleep?: Sleep;
  };
  /** Tests inject a directory (to change roles) and a clock (freshness, cutoff comparisons). */
  directory?: PrincipalDirectory;
  clock?: () => Date;
  limits?: Partial<BudgetLimits>;
  pricing?: Pricing;
  modelCall?: ModelCallConfig;
  queue?: Partial<AdmissionQueueOptions>;
  freshnessMs?: number;
  /** When set, every request's committed events are rendered as a trace tree through it. */
  trace?: TraceWriter;
  /** Receives hook/task failures the harness swallowed (its own default is a no-op). */
  onReport?: (error: unknown) => void;
  onAuthFailure?: HttpServerOptions["onAuthFailure"];
  onRunFailure?: HttpServerOptions["onRunFailure"];
  onRunOutcome?: HttpServerOptions["onRunOutcome"];
}

export const DEFAULT_QUEUE: AdmissionQueueOptions = { maxConcurrent: 2, maxQueued: 4, maxWaitMs: 5_000, retryAfterSeconds: 2 };

/**
 * The composition root. The connector, its credential, the retry policy, and every limit are
 * created here and reach the model only through the `lookup_booking` tool, which is closed over the
 * caller's server-created `SecurityContext` and the request's own budget.
 */
export async function createApp(options: CreateAppOptions) {
  const clock = options.clock ?? (() => new Date());
  const keys = await loadOrCreateIssuerKeys(options.issuerKeysPath ?? ISSUER_KEYS_PATH);
  const directory = options.directory ?? new PrincipalDirectory(loadTenantFixture().principals);

  const connector = new HttpBookingConnector({
    baseUrl: options.connector.baseUrl,
    credential: options.connector.credential ?? (() => process.env.BOOKING_API_TOKEN ?? FULL_ACCESS_TOKEN),
    pageSize: options.connector.pageSize ?? 50,
    maxPagesPerLookup: options.connector.maxPagesPerLookup ?? 10,
    maxResponseBytes: 64 * 1024,
    retry: { ...DEFAULT_RETRY, ...options.connector.retry },
    clock,
    sleep: options.connector.sleep,
  });
  const lookup = new BookingLookupService({ connector, clock, freshnessMs: options.freshnessMs });

  const sessions = new SessionAccessService(new SessionRegistry(options.paths.registryPath), options.paths.sessionsRoot);
  const capabilities = { lookup, directory };
  const chat = new ChatService({
    sessions,
    binding: options.binding,
    capabilities,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    pricing: options.pricing,
    modelCall: options.modelCall,
    trace: options.trace,
    onReport: options.onReport,
  });
  const queue = new AdmissionQueue({ ...DEFAULT_QUEUE, ...options.queue });
  const authenticate = createAuthenticator({ issuer: LOCAL_ISSUER, audience: LOCAL_AUDIENCE, publicKey: keys.publicKey, directory });
  const server = createHttpServer({ authenticate, chat, queue, onAuthFailure: options.onAuthFailure, onRunFailure: options.onRunFailure, onRunOutcome: options.onRunOutcome });
  return { server, keys, directory, connector, lookup, capabilities, sessions, chat, queue, authenticate, binding: options.binding };
}

export { modelBindingFromEnvironment };
