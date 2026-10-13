import type { Span } from "./trace.js";

const MARK: Record<Span["status"], string> = { ok: "◀", pending: "◀", denied: "✕", error: "✕" };

function formatAttributes(attributes: Span["attributes"]): string {
  const entries = Object.entries(attributes);
  return entries.length === 0 ? "" : ` ${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}`;
}

/**
 * Renders one run's spans as an indented tree, children under the span whose `spanId` they name as
 * `parentSpanId` — the same "show the nesting, don't make the reader rebuild it" idea as the Phase 1
 * trace loggers. Every line carries its attributes (the stage's arguments and findings), so a
 * failed boundary is readable without opening the JSONL. A span whose parent is missing from the
 * file (for example a dropped span) is shown at the top level, marked `(orphan)`, rather than hidden.
 */
export function renderTraceTree(spans: readonly Span[]): string[] {
  const ids = new Set(spans.map((span) => span.spanId));
  const childrenOf = new Map<string | null, Span[]>();
  for (const span of spans) {
    const parent = span.parentSpanId !== null && ids.has(span.parentSpanId) ? span.parentSpanId : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), span]);
  }

  const lines: string[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const span of childrenOf.get(parent) ?? []) {
      const orphan = parent === null && span.parentSpanId !== null ? " (orphan)" : "";
      lines.push(`${"  ".repeat(depth)}${MARK[span.status]} ${span.stage}/${span.name} status=${span.status}${orphan}${formatAttributes(span.attributes)}`);
      visit(span.spanId, depth + 1);
    }
  };
  visit(null, 0);
  return lines;
}
