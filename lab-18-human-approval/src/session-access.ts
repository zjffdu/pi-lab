import type { Context } from "@earendil-works/chord";

import { openSessionStorage, type OpenedSessionStorage } from "./session-store.js";
import type { SessionRegistry } from "./session-registry.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

/** Thrown for an unknown session and for someone else's session alike — same class, same message. */
export class SessionNotFoundError extends Error {
  public constructor() {
    super("Session not found.");
    this.name = "SessionNotFoundError";
  }
}

/** The registry's decision: this caller may use this session. No storage has been opened yet. */
export interface ResolvedSession {
  sessionId: string;
  tenantId: string;
  created: boolean;
}

/**
 * Resolves the session a request may use. Given no requested ID it creates a new personal session
 * owned by the caller; given one, it succeeds only if the registry says this caller owns it. The
 * registry — not the directory layout — is the access decision.
 *
 * Deciding and opening are separate steps on purpose. A JSONL storage reads its entries when it is
 * opened, so a request that waits behind another run on the same session must open the storage
 * *after* the wait, or it would run against a stale copy of the history. `ChatService` resolves
 * first (so a denial costs no storage read), then opens inside its per-session queue.
 */
export class SessionAccessService {
  public constructor(
    private readonly registry: SessionRegistry,
    private readonly sessionsRoot: string,
  ) {}

  public resolve(context: SecurityContext, requestedSessionId: string | undefined): ResolvedSession {
    assertSecurityContext(context);
    if (requestedSessionId === undefined) {
      const record = this.registry.create(context);
      return { sessionId: record.sessionId, tenantId: record.tenantId, created: true };
    }
    const record = this.registry.find(context, requestedSessionId);
    if (!record) throw new SessionNotFoundError();
    return { sessionId: record.sessionId, tenantId: record.tenantId, created: false };
  }

  public openStorage(session: ResolvedSession, runtimeContext: Context): Promise<OpenedSessionStorage> {
    return openSessionStorage(this.sessionsRoot, session.tenantId, session.sessionId, runtimeContext);
  }
}
