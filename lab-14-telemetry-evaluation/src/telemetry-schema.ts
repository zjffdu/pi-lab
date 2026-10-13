import {
  defineTelemetrySchema,
  type TelemetrySchemaSpanEndAttributes,
  type TelemetrySchemaSpanName,
  type TelemetrySchemaSpanStartAttributes,
} from "@earendil-works/pi-telemetry";

/**
 * This lab's own span vocabulary. In Pi 0.85.1 `pi-agent-core` shipped `HARNESS_TELEMETRY_SCHEMA` and
 * `AI_TELEMETRY_SCHEMA` (nine `pi.harness.*` span kinds plus `pi.ai.request`). Pi 1.1 ships neither: grep
 * `pi-durable`, `chord`, `pi-agent-core`, and `pi-ai` for `startSpan` and there is not one caller, and
 * `pi-durable` has no telemetry code at all. What remains is `@earendil-works/pi-telemetry` — the
 * `InMemoryTelemetryContext` recorder, `defineTelemetrySchema`, and `createTypedSpanStarter` — which is
 * exactly the toolkit for *declaring a vocabulary of your own*. So the names below are `lab.*`, never
 * `pi.*`: they describe what this lab's bridge builds from `pi-durable`'s committed event stream, not
 * something Pi defines.
 *
 * The vocabulary keeps the 0.85.1 concepts that still have a source in 1.1 (run, turn, provider request,
 * tool, retry, compaction) and drops the ones that do not (navigation has no event, checkpoint/sleep/
 * session-write have no 1.1 counterpart). Nothing here is validated at runtime — `pi-telemetry` uses a
 * schema for type inference only.
 */
export const LAB_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    "lab.run": {
      description: "One run: from `run_start` to `run_end` of one conversation's committed event stream",
      parents: { kind: "root_or_external" },
      startAttributes: {
        "lab.conversation.id": { type: "string", required: true, cardinality: "high", description: "Conversation id" },
        "lab.run.input_count": { type: "number", required: true, description: "Submissions this run answers" },
      },
      endAttributes: {},
      status: { default: "ok", errorWhen: "The stream stops before `run_end`" },
    },
    "lab.turn": {
      description: "One assistant response and the tool results that answer its tool calls",
      parents: { kind: "spans", spans: ["lab.run"] },
      startAttributes: {
        "lab.conversation.id": { type: "string", required: true, cardinality: "high", description: "Conversation id" },
        "lab.turn.number": { type: "number", required: true, description: "One-based turn number within this stream" },
      },
      endAttributes: {
        "lab.turn.tool_result_count": { type: "number", description: "Tool results committed during the turn" },
      },
      status: { default: "ok", errorWhen: "The stream stops before `turn_end`" },
    },
    "lab.ai.request": {
      description:
        "One provider request, built from the committed assistant message. Its extent is not observable " +
        "(the span has no timestamps); the request's own latency is the `lab.ai.duration_ms` attribute.",
      parents: { kind: "spans", spans: ["lab.turn", "lab.run"] },
      startAttributes: {
        "lab.ai.provider": { type: "string", required: true, description: "Provider id" },
        "lab.ai.model": { type: "string", required: true, description: "Requested model id" },
        "lab.ai.api": { type: "string", required: true, description: "Provider API id" },
      },
      endAttributes: {
        "lab.ai.response_model": { type: "string", description: "Concrete response model" },
        "lab.ai.response_id": { type: "string", cardinality: "high", description: "Provider response id" },
        "lab.ai.stop_reason": {
          type: "string",
          values: ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"],
          description: "Normalized terminal response reason",
        },
        "lab.ai.error_message": { type: "string", cardinality: "high", description: "Provider error text, when the request failed" },
        "lab.ai.duration_ms": {
          type: "number",
          description: "Monotonic milliseconds from request start to response end; absent for legacy or deferred results",
        },
        "lab.ai.usage.input_tokens": { type: "number", description: "Reported input tokens" },
        "lab.ai.usage.output_tokens": { type: "number", description: "Reported output tokens" },
        "lab.ai.usage.cache_read_tokens": { type: "number", description: "Reported cache-read tokens" },
        "lab.ai.usage.cache_write_tokens": { type: "number", description: "Reported cache-write tokens" },
        "lab.ai.usage.reasoning_tokens": { type: "number", description: "Reported reasoning tokens, when the provider splits them out" },
        "lab.ai.usage.total_tokens": { type: "number", description: "Reported total tokens" },
        "lab.ai.usage.cost": { type: "number", description: "Reported total cost" },
      },
      status: { default: "ok", errorWhen: "The response stop reason is `error` or `aborted`" },
    },
    "lab.tool": {
      description: "One tool execution, from `tool_execution_start` to `tool_execution_end`",
      parents: { kind: "spans", spans: ["lab.turn", "lab.run"] },
      startAttributes: {
        "lab.tool.name": { type: "string", required: true, description: "Tool name" },
        "lab.tool.call_id": { type: "string", required: true, cardinality: "high", description: "Tool call id" },
        "lab.tool.replay": { type: "string", required: true, values: ["safe", "unsafe"], description: "Declared replay policy" },
      },
      endAttributes: {
        "lab.tool.outcome": {
          type: "string",
          values: ["result", "faulted", "refused"],
          description:
            "`result`: the tool ran and a result entry was committed. `faulted`: the stream reported no entry (task faulted or orphaned). " +
            "`refused`: the harness never ran it (unknown tool, invalid arguments, or blocked) and committed an error result with no `tool_execution_start`",
        },
        "lab.tool.is_error": { type: "boolean", description: "Whether the committed tool result was an error result" },
      },
      status: { default: "ok", errorWhen: "The tool result is an error result, the call was refused, or no result entry was committed" },
    },
    "lab.retry": {
      description: "One automatic provider retry, from `auto_retry_start` to `auto_retry_end`",
      parents: { kind: "spans", spans: ["lab.turn", "lab.run"] },
      startAttributes: {
        "lab.retry.attempt": { type: "number", required: true, description: "Attempt number reported by the harness" },
        "lab.retry.reason": { type: "string", required: true, cardinality: "high", description: "Error text that triggered the retry" },
      },
      endAttributes: {},
      status: { default: "ok", errorWhen: "The stream stops before `auto_retry_end`" },
    },
    "lab.compaction": {
      description: "One compaction task, from `compaction_start` to `compaction_end`",
      parents: { kind: "root_or_external" },
      startAttributes: {
        "lab.conversation.id": { type: "string", required: true, cardinality: "high", description: "Conversation id" },
        "lab.compaction.task_id": { type: "string", required: true, cardinality: "high", description: "Compaction task id" },
        "lab.compaction.reason": { type: "string", required: true, values: ["manual", "threshold", "overflow"], description: "Compaction trigger" },
        "lab.compaction.blocking": { type: "boolean", required: true, description: "Whether generation waited for it" },
      },
      endAttributes: {},
      status: { default: "ok", errorWhen: "The stream stops before `compaction_end`" },
    },
  },
} as const);

export type LabSpanName = TelemetrySchemaSpanName<typeof LAB_TELEMETRY_SCHEMA>;
export type LabSpanStartAttributes<Name extends LabSpanName> = TelemetrySchemaSpanStartAttributes<typeof LAB_TELEMETRY_SCHEMA, Name>;
export type LabSpanEndAttributes<Name extends LabSpanName> = TelemetrySchemaSpanEndAttributes<typeof LAB_TELEMETRY_SCHEMA, Name>;

/** Every span name this lab's bridge can produce. */
export const PRODUCIBLE_SPAN_NAMES = Object.keys(LAB_TELEMETRY_SCHEMA.spans) as LabSpanName[];
