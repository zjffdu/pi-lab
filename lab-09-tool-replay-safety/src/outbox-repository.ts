import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The lab's only "external side effect": a local, append-only record of one booking-hold
 * request having actually happened. `request-booking-hold-tool.ts` is the only writer,
 * and it appends synchronously *before* its artificial post-effect delay — the same
 * ordering a real outbox pattern relies on ("commit the local effect, then talk to the
 * outside world"). This is deliberately not a real notification, booking system, or API;
 * the roadmap explicitly excludes those. What matters for this lab is only whether this
 * file ever ends up with a duplicated entry for the same logical request.
 */
export interface OutboxRecord {
  invocationId: string;
  bookingNo: string;
  reason: string;
  holdId: string;
  at: number;
}

export class OutboxRepository {
  public constructor(private readonly filePath: string) {}

  /** Synchronous so the effect is durable on disk before `execute()` can be killed. */
  public appendSync(record: OutboxRecord): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  public readAll(): OutboxRecord[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    return readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as OutboxRecord);
  }

  public reset(): void {
    rmSync(this.filePath, { force: true });
  }
}
