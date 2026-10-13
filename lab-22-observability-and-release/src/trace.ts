import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The seven boundaries the roadmap requires spans for. `pipeline.ts` emits at most one span per
 * stage per run — a stage a scenario never reaches (for example `approval` on a policy denial)
 * simply has no span, which is what lets `evidence.ts` tell "this run never needed a tool call"
 * apart from "the tool stage ran but nobody recorded it".
 */
export const STAGES = ["request", "policy", "approval", "tool", "connector", "retry", "delivery"] as const;
export type Stage = (typeof STAGES)[number];

export type SpanStatus = "ok" | "error" | "denied" | "pending";

export interface Span {
  readonly runId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly stage: Stage;
  readonly name: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
}

let counter = 0;
function nextSpanId(): string {
  counter += 1;
  return `span-${Date.now().toString(36)}-${counter}`;
}

/** One file per run: `<traceDir>/<runId>.jsonl`, so re-running a case never mixes two runs' spans. */
export const tracePathFor = (traceDir: string, runId: string): string => join(traceDir, `${runId}.jsonl`);

/**
 * Records spans in memory (read by `evidence.ts` and `metrics.ts` for the run just executed) and,
 * when a `traceDir` is given, appends each finished span as one JSON line to that run's own file
 * under it — the durable, inspectable form the RUNBOOK points an operator at (`npm run trace`
 * renders it as a tree) when a case fails and they need to find which boundary was responsible.
 */
export class Tracer {
  private readonly spans: Span[] = [];

  public constructor(
    private readonly runId: string,
    private readonly traceDir?: string,
  ) {}

  public span(stage: Stage, name: string, parentSpanId: string | null, status: SpanStatus, attributes: Record<string, string | number | boolean | null>, durationMs = 0): Span {
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - durationMs);
    const span: Span = {
      runId: this.runId,
      spanId: nextSpanId(),
      parentSpanId,
      stage,
      name,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      status,
      attributes: Object.freeze({ ...attributes }),
    };
    this.spans.push(span);
    if (this.traceDir) {
      mkdirSync(this.traceDir, { recursive: true });
      appendFileSync(tracePathFor(this.traceDir, this.runId), `${JSON.stringify(span)}\n`, "utf8");
    }
    return span;
  }

  public all(): readonly Span[] {
    return this.spans;
  }

  public byStage(stage: Stage): readonly Span[] {
    return this.spans.filter((entry) => entry.stage === stage);
  }
}

const isSpan = (value: unknown): value is Span => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.runId === "string" && typeof candidate.spanId === "string" && typeof candidate.name === "string" && typeof candidate.stage === "string" && typeof candidate.status === "string";
};

/** Runtime-validated read of one run's JSONL trace — no `as` cast on persisted evidence. */
export function readTraceFile(path: string): Span[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const parsed: unknown = JSON.parse(line);
      if (!isSpan(parsed)) throw new Error(`${path}:${index + 1} is not a valid span`);
      return parsed;
    });
}

/** The newest trace file for a case id (`run-<caseId>-<epoch>.jsonl`), or undefined if it has never run. */
export function latestTraceFor(traceDir: string, caseId: string): string | undefined {
  const pattern = new RegExp(`^run-${caseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\.jsonl$`);
  const matches = readdirSync(traceDir).filter((name) => pattern.test(name)).map((name) => join(traceDir, name));
  return matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}
