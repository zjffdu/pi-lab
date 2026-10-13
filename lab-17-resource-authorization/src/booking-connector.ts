import type { DelegatedTokenProvider } from "./delegation.js";
import { DOWNSTREAM_AUDIENCE, SCOPE_WRITE } from "./delegation.js";
import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export interface StatusChangeRequest {
  bookingNo: string;
  newStatus: string;
  /** The status the authorization decision saw; the downstream refuses the change if it moved. */
  expectedStatus: string;
}

export interface StatusChangeResult {
  bookingNo: string;
  previousStatus: string;
  newStatus: string;
}

export type ConnectorErrorCode = "unauthorized" | "forbidden" | "not_found" | "conflict" | "unavailable" | "bad_response";

/** Messages are fixed strings: nothing here can echo a token, a header, or a downstream body. */
export class ConnectorError extends Error {
  public constructor(public readonly code: ConnectorErrorCode) {
    super(`Booking system rejected the request (${code}).`);
    this.name = "ConnectorError";
  }
}

export interface BookingConnector {
  updateStatus(context: SecurityContext, request: StatusChangeRequest): Promise<StatusChangeResult>;
}

export interface HttpBookingConnectorOptions {
  baseUrl: string;
  tokens: DelegatedTokenProvider;
  /** Overridable so tests can exercise a wrong-audience credential. */
  audience?: string;
  /** Overridable so tests can exercise an under-scoped credential. */
  scopes?: readonly string[];
  timeoutMs?: number;
}

const CODE_FOR_STATUS: Record<number, ConnectorErrorCode> = { 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict" };

function isStatusChangeResult(value: unknown): value is StatusChangeResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.bookingNo === "string" && typeof candidate.previousStatus === "string" && typeof candidate.newStatus === "string";
}

/**
 * The only holder of a credential. It asks the provider for a delegated token for *this*
 * `SecurityContext`'s principal, sends it, and throws it away; nothing it returns or throws
 * contains the token. The application above it deals in `SecurityContext` and typed results.
 */
export class HttpBookingConnector implements BookingConnector {
  public constructor(private readonly options: HttpBookingConnectorOptions) {}

  public async updateStatus(context: SecurityContext, request: StatusChangeRequest): Promise<StatusChangeResult> {
    assertSecurityContext(context);
    const token = await this.options.tokens.acquire(context, {
      audience: this.options.audience ?? DOWNSTREAM_AUDIENCE,
      scopes: this.options.scopes ?? [SCOPE_WRITE],
    });

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/bookings/${encodeURIComponent(request.bookingNo)}/status`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ newStatus: request.newStatus, expectedStatus: request.expectedStatus }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
    } catch {
      throw new ConnectorError("unavailable");
    }

    if (!response.ok) throw new ConnectorError(CODE_FOR_STATUS[response.status] ?? "bad_response");
    const body: unknown = await response.json();
    if (!isStatusChangeResult(body)) throw new ConnectorError("bad_response");
    return body;
  }
}
