import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { AuditLog, createFileLineWriter, readAuditLog } from "./audit-log.js";
import {
  createBookingRegistry,
  GOVERNED_TOOL_NAME,
  modelSelectionFromEnvironment,
  offeredToolNames,
  openHarness,
} from "./create-harness.js";
import { attachTraceLogger } from "./harness-trace-logger.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "./session-store.js";
import { describeEntry, listEntries } from "./transcript.js";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));
const AUDIT_LOG_PATH = fileURLToPath(new URL("../runtime-data/audit-log.jsonl", import.meta.url));

type Mode = { kind: "prompt"; prompt: string } | { kind: "inspect" } | { kind: "inspect-audit" };

interface CliArgs {
  sessionId: string | undefined;
  mode: Mode;
  enableGovernedTool: boolean;
  failAuditSink: boolean;
  simulatePolicyBug: boolean;
}

const USAGE =
  'Usage: npm run agent -- --session <id> [--enable-governed-tool] [--fail-audit-sink] [--simulate-policy-bug] --prompt "<text>"\n' +
  "   or: npm run agent -- --session <id> --inspect\n" +
  "   or: npm run agent -- --inspect-audit\n" +
  "One CLI invocation is one turn or one read-only inspection. A new session offers only get_booking; " +
  `--enable-governed-tool offers "${GOVERNED_TOOL_NAME}" too, and the session keeps offering it in later invocations ` +
  "(what a conversation offers is stored with the conversation).";

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | undefined;
  let prompt: string | undefined;
  let inspect = false;
  let inspectAudit = false;
  let enableGovernedTool = false;
  let failAuditSink = false;
  let simulatePolicyBug = false;

  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--session") {
      sessionId = argv[index + 1];
      index += 2;
    } else if (flag === "--prompt") {
      prompt = argv[index + 1];
      index += 2;
    } else if (flag === "--inspect") {
      inspect = true;
      index += 1;
    } else if (flag === "--inspect-audit") {
      inspectAudit = true;
      index += 1;
    } else if (flag === "--enable-governed-tool") {
      enableGovernedTool = true;
      index += 1;
    } else if (flag === "--fail-audit-sink") {
      failAuditSink = true;
      index += 1;
    } else if (flag === "--simulate-policy-bug") {
      simulatePolicyBug = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${flag}".\n${USAGE}`);
    }
  }

  const modes: Mode[] = [
    ...(prompt ? [{ kind: "prompt", prompt } as const] : []),
    ...(inspect ? [{ kind: "inspect" } as const] : []),
    ...(inspectAudit ? [{ kind: "inspect-audit" } as const] : []),
  ];
  const [mode, ...extra] = modes;
  if (mode === undefined || extra.length > 0) {
    throw new Error(`Exactly one of --prompt, --inspect, or --inspect-audit is required.\n${USAGE}`);
  }
  if (mode.kind !== "inspect-audit" && !sessionId) {
    throw new Error(USAGE);
  }

  return { sessionId, mode, enableGovernedTool, failAuditSink, simulatePolicyBug };
}

async function main(): Promise<void> {
  const { sessionId, mode, enableGovernedTool, failAuditSink, simulatePolicyBug } = parseArgs(process.argv.slice(2));
  const context = BACKGROUND_CONTEXT;

  if (mode.kind === "inspect-audit") {
    const records = await readAuditLog(AUDIT_LOG_PATH);
    console.log(`[Audit] path=${AUDIT_LOG_PATH} records=${records.length}`);
    for (const record of records) {
      console.log(
        `  at=${record.at} phase=${record.phase} decision=${record.decision} tool=${record.toolName} ` +
          `session=${record.sessionId} conversation=${record.conversationId} task=${record.taskId} call=${record.toolCallId} ` +
          `args=${JSON.stringify(record.args)}${record.reason ? ` reason=${JSON.stringify(record.reason)}` : ""}`,
      );
    }
    return;
  }

  const id = sessionId as string;
  const models = builtinModels();
  const { storage, created, path } = await openSessionStorage(SESSIONS_ROOT, id, context);
  console.log(`[Session] id=${id} ${created ? "created" : "reopened"} path=${path}`);

  // The governance decisions are printed as they are written, so a blocked call's audit line sits in the
  // trace right next to the `⊘ tool_refused` line it belongs to.
  const writeToFile = createFileLineWriter(AUDIT_LOG_PATH);
  const auditLog = failAuditSink
    ? new AuditLog(() => {
        throw new Error("Simulated audit-sink failure (--fail-audit-sink).");
      })
    : new AuditLog(async (line) => {
        await writeToFile(line);
        const record = JSON.parse(line) as { phase: string; decision: string; toolCallId: string; taskId: number };
        console.log(`[Audit] phase=${record.phase} decision=${record.decision} call=${record.toolCallId} task=${record.taskId}`);
      });

  const booking = createBookingRegistry({ sessionId: id, auditLog, simulatePolicyBug });
  const { harness, root, inspection } = await openHarness(
    storage,
    { models, selection: modelSelectionFromEnvironment(), booking, offerGovernedTool: enableGovernedTool },
    context,
  );
  console.log(
    `[Harness] unfinishedTasks=${inspection.tasks.length} unsettledSubmissions=${inspection.submissions.length} ` +
      `offeredTools=${JSON.stringify(await offeredToolNames(root, context))}`,
  );

  async function printEntries(when: "before" | "after"): Promise<void> {
    const entries = await listEntries(root, context);
    console.log(`[Entries][${when}] total=${entries.length}`);
    for (const entry of entries) {
      console.log(`  ${entry.id} ${describeEntry(entry)}`);
    }
  }

  await printEntries("before");

  let failed = false;
  if (mode.kind === "prompt") {
    const trace = await attachTraceLogger(harness, root.id, (line) => console.log(line), context);
    console.log(`[User] ${mode.prompt}`);
    const submission = await root.submit({ type: "input", content: mode.prompt }, context);
    const settled = await submission.wait(context);
    await trace.settled(settled.id);
    await trace.stop();
    console.log(`[Submission] id=${settled.id} status=${settled.status}`);
    failed = settled.status !== "done";
    await printEntries("after");
  }

  await harness.close(context);

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
