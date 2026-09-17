import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One real call to a tool's `execute()`, independent of anything the harness itself
 * durably records. This is the lab's answer to "count actual tool executions separately
 * from committed tool-result entries": the harness's own JSONL may show only one committed
 * `toolResult` entry for a logical call even though `execute()` ran twice (a "safe"-replay
 * recovery), or it may show a synthesized error result for a call whose `execute()` only
 * ever ran once (a "never"-replay interruption). Neither fact is visible from the JSONL
 * alone — this file is what makes it visible.
 */
export interface ToolAttempt {
  tool: string;
  toolCallId: string;
  invocationId: string;
  detail: string;
  at: number;
}

export class AttemptLog {
  public constructor(private readonly filePath: string) {}

  /**
   * Synchronous and called before any `await` in a tool's `execute()`, the same way the
   * checkpoint print is — so a `SIGKILL` immediately after this line still leaves the
   * attempt durable on disk, exactly like the effect it is meant to be compared against.
   */
  public recordSync(attempt: ToolAttempt): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(attempt)}\n`, "utf8");
  }

  public readAll(): ToolAttempt[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    return readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ToolAttempt);
  }

  public reset(): void {
    rmSync(this.filePath, { force: true });
  }
}
