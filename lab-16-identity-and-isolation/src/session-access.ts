import type { Context } from "@earendil-works/chord";
import type { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

import type { SessionRegistry } from "./session-registry.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";
import { openSessionStorage } from "./session-store.js";

/** Thrown for an unknown session and for someone else's session alike — same class, same message. */
export class SessionNotFoundError extends Error {
  public constructor() {
    super("Session not found.");
    this.name = "SessionNotFoundError";
  }
}

export interface OpenedSession {
  sessionId: string;
  storage: JsonlStorage;
  created: boolean;
}

/**
 * Resolves the session storage a request may use. Given no requested ID it creates a new personal session
 * owned by the caller; given one, it succeeds only if the registry says this caller owns it. Nothing is
 * opened — no directory created, no file touched — until the registry has approved the request.
 */
export class SessionAccessService {
  public constructor(
    private readonly registry: SessionRegistry,
    private readonly sessionsRoot: string,
  ) {}

  public async open(context: SecurityContext, requestedSessionId: string | undefined, runtime: Context): Promise<OpenedSession> {
    assertSecurityContext(context);

    const record = requestedSessionId === undefined ? this.registry.create(context) : this.registry.find(context, requestedSessionId);
    if (!record) throw new SessionNotFoundError();

    const { storage, created } = await openSessionStorage(this.sessionsRoot, record.tenantId, record.sessionId, runtime);
    return { sessionId: record.sessionId, storage, created };
  }
}
