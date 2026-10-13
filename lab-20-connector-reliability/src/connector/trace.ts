import type { FailureCategory } from "./errors.js";

/**
 * One HTTP attempt as the connector saw it. `requestId` comes from the server-created
 * `SecurityContext`, `toolCallId` from Pi, and `opId` names one logical request (one page) — the same
 * three values are sent to the API as headers, so a record here can be matched to the API's own log.
 */
export interface AttemptRecord {
  requestId: string;
  toolCallId: string;
  opId: string;
  route: "booking" | "containers";
  page: number;
  attempt: number;
  outcome: "ok" | "not_found" | FailureCategory;
  httpStatus?: number;
  elapsedMs: number;
  /** Backoff or `Retry-After` wait taken just before this attempt. */
  waitBeforeMs: number;
}

export class AttemptTrace {
  public readonly records: AttemptRecord[] = [];

  public push(record: AttemptRecord): void {
    this.records.push(record);
  }

  public forToolCall(toolCallId: string): AttemptRecord[] {
    return this.records.filter((record) => record.toolCallId === toolCallId);
  }
}
