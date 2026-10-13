import { existsSync } from "node:fs";

import { latestTraceFor, readTraceFile, tracePathFor } from "../src/trace.js";
import { renderTraceTree } from "../src/trace-render.js";

const TRACE_DIR = "runtime-evidence/traces";
const target = process.argv[2];
if (!target) {
  console.error("Usage: npm run trace -- <caseId | runId | path-to-trace.jsonl>   (run npm run run:dev or run:held-out first)");
  process.exit(2);
}

const path = existsSync(target) ? target : existsSync(tracePathFor(TRACE_DIR, target)) ? tracePathFor(TRACE_DIR, target) : existsSync(TRACE_DIR) ? latestTraceFor(TRACE_DIR, target) : undefined;
if (!path) {
  console.error(`No trace found for "${target}" under ${TRACE_DIR}/.`);
  process.exit(1);
}

console.log(`[trace] ${path}`);
for (const line of renderTraceTree(readTraceFile(path))) console.log(line);
