import {
  DELIVER_PATH,
  FENCING_HEADER,
  IDEMPOTENCY_HEADER,
  lookupPath,
  parseDeliverResponse,
  parseLookupResponse,
  type DeliverRequest,
  type DeliverResponse,
  type LookupResponse,
} from "./receiver/contract.js";

/**
 * What a delivery attempt taught the worker. The categories are ordered by how much they prove:
 *
 * - `applied` / `rejected`: the receiver answered definitively. Only these say what happened.
 * - `stale_fence`: the receiver refused a token older than one it had already accepted.
 * - `not_sent`: the TCP connection was refused, so no request bytes reached the receiver. This is
 *   the one transport failure that *does* prove the effect did not happen.
 * - `ambiguous`: everything else — timeout, connection lost, a 5xx, an unparseable answer. The
 *   request may or may not have been applied; nothing may be concluded from the failure itself.
 */
export type DeliverOutcome =
  | { kind: "applied"; response: Extract<DeliverResponse, { result: "applied" }> }
  | { kind: "rejected"; code: string; status: number }
  | { kind: "stale_fence" }
  | { kind: "not_sent"; reason: string }
  | { kind: "ambiguous"; reason: string };

export type LookupOutcome =
  | { kind: "applied"; response: Extract<LookupResponse, { state: "applied" }> }
  | { kind: "rejected"; code: string }
  | { kind: "not_found" }
  | { kind: "unsupported" }
  | { kind: "unavailable"; reason: string };

export interface ReceiverClientOptions {
  baseUrl: string;
  /** Per-request timeout. Must be shorter than the worker's lease, or a live worker can lose its lease mid-request. */
  timeoutMs: number;
}

const errorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof direct === "string") return direct;
  if (typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string") return (cause as { code: string }).code;
  return undefined;
};

/**
 * HTTP client for the receiver. It performs **no retries**: retry ownership sits with the outbox
 * (attempt counts, backoff, and the decision to reconcile first), so a transport retry here would be
 * a second, invisible retry owner multiplying attempts.
 */
export class ReceiverClient {
  public constructor(private readonly options: ReceiverClientOptions) {}

  public get timeoutMs(): number {
    return this.options.timeoutMs;
  }

  public async deliver(input: { request: DeliverRequest; idempotencyKey: string; fencingToken: number }): Promise<DeliverOutcome> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${DELIVER_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", [IDEMPOTENCY_HEADER]: input.idempotencyKey, [FENCING_HEADER]: String(input.fencingToken) },
        body: JSON.stringify(input.request),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { kind: "ambiguous", reason: "timeout" };
      if (errorCode(error) === "ECONNREFUSED") return { kind: "not_sent", reason: "connection_refused" };
      return { kind: "ambiguous", reason: `connection_lost:${errorCode(error) ?? "unknown"}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return { kind: "ambiguous", reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : `unreadable_body_http_${response.status}` };
    }
    if (response.status >= 500) return { kind: "ambiguous", reason: `http_${response.status}` };
    const parsed = parseDeliverResponse(body);
    if (!parsed) return { kind: "ambiguous", reason: `unexpected_response_http_${response.status}` };
    if (parsed.result === "applied") return response.status === 200 ? { kind: "applied", response: parsed } : { kind: "ambiguous", reason: `applied_body_with_http_${response.status}` };
    if (parsed.code === "stale_fence") return { kind: "stale_fence" };
    return { kind: "rejected", code: parsed.code, status: response.status };
  }

  public async lookup(idempotencyKey: string): Promise<LookupOutcome> {
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${lookupPath(idempotencyKey)}`, { signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch (error) {
      return { kind: "unavailable", reason: error instanceof Error && error.name === "TimeoutError" ? "timeout" : `connection:${errorCode(error) ?? "unknown"}` };
    }
    if (response.status === 501) return { kind: "unsupported" };
    if (response.status !== 200) return { kind: "unavailable", reason: `http_${response.status}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "unavailable", reason: "unreadable_body" };
    }
    const parsed = parseLookupResponse(body);
    if (!parsed) return { kind: "unavailable", reason: "unexpected_response" };
    if (parsed.state === "applied") return { kind: "applied", response: parsed };
    if (parsed.state === "rejected") return { kind: "rejected", code: parsed.code };
    return { kind: "not_found" };
  }
}
