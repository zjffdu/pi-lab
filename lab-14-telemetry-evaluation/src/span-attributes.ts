/**
 * Which attributes `renderSpanTree` prints for each span name — the few that make a captured run readable at a
 * glance. Everything else stays in the JSON report.
 */
export const SPAN_TREE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  "lab.turn": ["lab.turn.number", "lab.turn.tool_result_count"],
  "lab.ai.request": ["lab.ai.stop_reason", "lab.ai.usage.total_tokens", "lab.ai.duration_ms"],
  "lab.tool": ["lab.tool.name", "lab.tool.replay", "lab.tool.outcome", "lab.tool.is_error"],
  "lab.retry": ["lab.retry.attempt"],
  "lab.compaction": ["lab.compaction.reason", "lab.compaction.blocking"],
};
