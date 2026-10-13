import type { RecordedTelemetrySpan } from "@earendil-works/pi-telemetry";

/**
 * `InMemoryTelemetryContext.getSpans()` (`pi-telemetry/dist/memory.js:138-152`) returns a flat
 * array in span-start order, `{id, parentId}` only — no built-in tree or query API (confirmed
 * absent from `pi-telemetry/dist/index.d.ts`). Every helper here operates on that flat array
 * directly; nothing here is Pi API surface, it is this lab's own reconstruction.
 */

export function childrenIndex(spans: readonly RecordedTelemetrySpan[]): Map<number | null, RecordedTelemetrySpan[]> {
  const index = new Map<number | null, RecordedTelemetrySpan[]>();
  for (const span of spans) {
    const bucket = index.get(span.parentId);
    if (bucket) {
      bucket.push(span);
    } else {
      index.set(span.parentId, [span]);
    }
  }
  return index;
}

export function rootSpans(spans: readonly RecordedTelemetrySpan[]): RecordedTelemetrySpan[] {
  return spans.filter((span) => span.parentId === null);
}

export function byId(spans: readonly RecordedTelemetrySpan[]): Map<number, RecordedTelemetrySpan> {
  return new Map(spans.map((span) => [span.id, span]));
}

export function findByName(spans: readonly RecordedTelemetrySpan[], name: string): RecordedTelemetrySpan[] {
  return spans.filter((span) => span.name === name);
}

export function findByAttribute(
  spans: readonly RecordedTelemetrySpan[],
  key: string,
  value: unknown,
): RecordedTelemetrySpan[] {
  return spans.filter((span) => span.attributes[key] === value);
}

/** All descendants of `rootId`, in `getSpans()`'s own start order (BFS, but the order key is the array's own order, not traversal order). */
export function descendantsOf(spans: readonly RecordedTelemetrySpan[], rootId: number): RecordedTelemetrySpan[] {
  const children = childrenIndex(spans);
  const result: RecordedTelemetrySpan[] = [];
  const queue = [...(children.get(rootId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) continue;
    result.push(next);
    queue.push(...(children.get(next.id) ?? []));
  }
  return result;
}

export function parentOf(
  spans: readonly RecordedTelemetrySpan[],
  span: RecordedTelemetrySpan,
): RecordedTelemetrySpan | undefined {
  if (span.parentId === null) return undefined;
  return byId(spans).get(span.parentId);
}

export interface SpanCoverage {
  name: string;
  count: number;
}

/** One row per span name actually present, in first-seen order — used to report which schema span kinds this run produced. */
export function spanCoverage(spans: readonly RecordedTelemetrySpan[]): SpanCoverage[] {
  const counts = new Map<string, number>();
  for (const span of spans) {
    counts.set(span.name, (counts.get(span.name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

function formatAttributeValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Renders a flat `getSpans()` capture as an indented tree, so the telemetry side of a run reads like the
 * trace side (`harness-trace-logger.ts`). `attributes` selects which attributes print per span name; a name
 * with no entry prints none. Spans with an unknown `parentId` (a parent the capture does not contain) are
 * printed as roots rather than dropped. An unsettled span is marked `…` and an error status `✗`.
 */
export function renderSpanTree(
  spans: readonly RecordedTelemetrySpan[],
  attributes: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const known = new Set(spans.map((span) => span.id));
  const children = childrenIndex(spans);
  const roots = spans.filter((span) => span.parentId === null || !known.has(span.parentId));
  const lines: string[] = [];

  const visit = (span: RecordedTelemetrySpan, depth: number): void => {
    const shown = (attributes[span.name] ?? [])
      .filter((key) => span.attributes[key] !== undefined)
      .map((key) => `${key.split(".").slice(1).join(".")}=${formatAttributeValue(span.attributes[key])}`);
    const marks = `${span.settled ? "" : " …"}${span.status.status === "error" ? " ✗" : ""}`;
    lines.push(`${"  ".repeat(depth)}${span.name} #${span.id}${shown.length > 0 ? ` ${shown.join(" ")}` : ""}${marks}`);
    for (const child of children.get(span.id) ?? []) visit(child, depth + 1);
  };

  for (const root of roots) visit(root, 0);
  return lines;
}
