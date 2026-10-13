/**
 * The wire contract between the delivery worker and the receiver, plus the *assumptions* a receiver
 * may or may not satisfy. Every effect guarantee in this lab is stated relative to one of these
 * `ReceiverContract` values — the tests are parameterized by it.
 */
export interface ReceiverContract {
  /**
   * `key`: the receiver applies at most one effect per idempotency key and replays the first outcome
   * for repeats. `none`: it ignores the key for deduplication (it may still log it).
   */
  idempotency: "key" | "none";
  /** Whether `GET /v1/status-changes/:key` answers "did this request take effect?". */
  lookup: boolean;
  /** Whether the receiver rejects a request whose fencing token is lower than one it already accepted for the key. */
  fencing: boolean;
}

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const FENCING_HEADER = "x-fencing-token";
export const DELIVER_PATH = "/v1/status-changes";
export const lookupPath = (key: string): string => `${DELIVER_PATH}/${encodeURIComponent(key)}`;

export interface DeliverRequest {
  tenantId: string;
  bookingNo: string;
  newStatus: string;
  /** Precondition: apply only if the receiver's booking is still at this version. */
  expectedVersion: number;
}

export type DeliverResponse =
  | { result: "applied"; replayed: boolean; effectId: number; bookingNo: string; newStatus: string; toVersion: number }
  | { result: "rejected"; code: string };

export type LookupResponse =
  | { state: "applied"; bookingNo: string; newStatus: string; toVersion: number; effectCount: number }
  | { state: "rejected"; code: string }
  | { state: "not_found" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

export function parseDeliverRequest(value: unknown): DeliverRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { tenantId, bookingNo, newStatus, expectedVersion } = value;
  if (!isString(tenantId) || !isString(bookingNo) || !isString(newStatus) || !isInt(expectedVersion)) return undefined;
  return { tenantId, bookingNo, newStatus, expectedVersion };
}

export function parseDeliverResponse(value: unknown): DeliverResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (value.result === "rejected" && isString(value.code)) return { result: "rejected", code: value.code };
  if (value.result === "applied" && typeof value.replayed === "boolean" && isInt(value.effectId) && isString(value.bookingNo) && isString(value.newStatus) && isInt(value.toVersion)) {
    return { result: "applied", replayed: value.replayed, effectId: value.effectId, bookingNo: value.bookingNo, newStatus: value.newStatus, toVersion: value.toVersion };
  }
  return undefined;
}

export function parseLookupResponse(value: unknown): LookupResponse | undefined {
  if (!isRecord(value)) return undefined;
  if (value.state === "not_found") return { state: "not_found" };
  if (value.state === "rejected" && isString(value.code)) return { state: "rejected", code: value.code };
  if (value.state === "applied" && isString(value.bookingNo) && isString(value.newStatus) && isInt(value.toVersion) && isInt(value.effectCount)) {
    return { state: "applied", bookingNo: value.bookingNo, newStatus: value.newStatus, toVersion: value.toVersion, effectCount: value.effectCount };
  }
  return undefined;
}
