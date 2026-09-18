import "dotenv/config";

import { fileURLToPath } from "node:url";

import type { NavigationResult, RunResult } from "@earendil-works/pi-agent-core";

import { openMainLane } from "./create-harness.js";
import { attachHarnessTraceLogger } from "./harness-trace-logger.js";
import { BACKGROUND_CONTEXT, createSessionRepo, openOrCreateSession } from "./session-store.js";
import { findBranchTips, renderTree } from "./tree-view.js";

/** Fixed grouping key, same role as earlier labs' `SESSION_GROUP` — see `openOrCreateSession`. */
const SESSION_GROUP = "lab-11-session-tree";

const SESSIONS_ROOT = fileURLToPath(new URL("../session-data", import.meta.url));

interface CliArgs {
  sessionId: string;
  prompt: string | undefined;
  navigateTarget: string | undefined;
  navigateLabel: string | undefined;
  summarize: boolean;
  setLabelTarget: string | undefined;
  setLabelText: string | undefined;
  inspect: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let sessionId: string | undefined;
  let prompt: string | undefined;
  let navigateTarget: string | undefined;
  let navigateLabel: string | undefined;
  let summarize = false;
  let setLabelTarget: string | undefined;
  let setLabelText: string | undefined;
  let inspect = false;

  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--session") {
      sessionId = argv[index + 1];
      index += 2;
    } else if (flag === "--prompt") {
      prompt = argv[index + 1];
      index += 2;
    } else if (flag === "--navigate") {
      navigateTarget = argv[index + 1];
      index += 2;
    } else if (flag === "--label") {
      navigateLabel = argv[index + 1];
      index += 2;
    } else if (flag === "--summarize") {
      summarize = true;
      index += 1;
    } else if (flag === "--set-label") {
      setLabelTarget = argv[index + 1];
      setLabelText = argv[index + 2];
      index += 3;
    } else if (flag === "--inspect") {
      inspect = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${flag}".`);
    }
  }

  if (!sessionId) {
    throw new Error(
      'Usage: npm run agent -- --session <id> --prompt "<text>"\n' +
        "   or: npm run agent -- --session <id> --navigate <entryId|root> [--label \"<text>\"] [--summarize]\n" +
        '   or: npm run agent -- --session <id> --set-label <entryId> "<text>"\n' +
        "   or: npm run agent -- --session <id> --inspect\n" +
        "One CLI invocation is one turn, one navigation, one label write, or one read-only inspection.",
    );
  }
  const modeCount = [Boolean(prompt), Boolean(navigateTarget), Boolean(setLabelTarget), inspect].filter(
    Boolean,
  ).length;
  if (modeCount !== 1) {
    throw new Error("Exactly one of --prompt, --navigate, --set-label, or --inspect is required.");
  }
  if ((navigateLabel !== undefined || summarize) && !navigateTarget) {
    throw new Error("--label and --summarize only apply to --navigate.");
  }

  return { sessionId, prompt, navigateTarget, navigateLabel, summarize, setLabelTarget, setLabelText, inspect };
}

function logRunResult(label: string, result: RunResult): boolean {
  if (!result.ok) {
    console.log(`[${label}] rejected: ${result.error._tag}: ${result.error.message}`);
    return true;
  }
  if (result.value.status === "suspended") {
    console.log(`[${label}] operationId=${result.value.operationId} status=suspended (deferred provider response)`);
    return false;
  }
  const record = result.value;
  console.log(
    `[${label}] operationId=${record.operationId} kind=${record.kind} status=${record.status} ` +
      `fromTip=${record.fromTipId ?? "null"} tip=${record.tipId ?? "null"}`,
  );
  if (record.status !== "completed" && record.error) {
    console.error(`[Fatal] operation ${record.status}: ${record.error.code}: ${record.error.message}`);
    return true;
  }
  return false;
}

function logNavigationResult(result: NavigationResult): boolean {
  if (!result.ok) {
    console.log(`[Navigate] rejected: ${result.error._tag}: ${result.error.message}`);
    return true;
  }
  const record = result.value.navigation;
  console.log(
    `[Navigate] operationId=${record.operationId} kind=${record.kind} status=${record.status} ` +
      `fromTip=${record.fromTipId ?? "null"} tip=${record.tipId ?? "null"}`,
  );
  if (record.status !== "completed" && record.error) {
    console.error(`[Fatal] navigation ${record.status}: ${record.error.code}: ${record.error.message}`);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const { sessionId, prompt, navigateTarget, navigateLabel, summarize, setLabelTarget, setLabelText, inspect } =
    parseArgs(process.argv.slice(2));
  const context = BACKGROUND_CONTEXT;

  const repo = createSessionRepo(SESSIONS_ROOT);
  const { session, created } = await openOrCreateSession(repo, sessionId, SESSION_GROUP, context);

  console.log(
    `[Session] id=${session.metadata.id} ${created ? "created" : "reopened"} path=${session.metadata.path}`,
  );

  const { harness, lane, open } = await openMainLane(session, context);
  console.log(`[Harness] lane=main openOperationsOnAttach=${open.length}`);

  async function printTree(when: "before" | "after"): Promise<void> {
    const allEntries = await session.findEntries({ order: "asc" }, context);
    const tipId = await lane.getTipId(context);
    const labels = new Map<string, string>();
    for (const entry of allEntries) {
      const label = await harness.getLabel(entry.id, context);
      if (label !== undefined) {
        labels.set(entry.id, label);
      }
    }
    const tips = findBranchTips(allEntries);
    console.log(
      `[Tree][${when}] totalEntries=${allEntries.length} branchTips=${tips.length} activeTip=${tipId ?? "null"}`,
    );
    console.log(renderTree(allEntries, { labels, activeTipId: tipId }));
  }

  await printTree("before");

  if (inspect) {
    await harness.close(context);
    await repo.close(context);
    return;
  }

  if (setLabelTarget !== undefined) {
    console.log(`[Label][${sessionId}] setLabel(${setLabelTarget}, ${JSON.stringify(setLabelText ?? "")})`);
    await harness.setLabel(setLabelTarget, setLabelText, context);
    await printTree("after");
    await harness.close(context);
    await repo.close(context);
    return;
  }

  const detachTrace = attachHarnessTraceLogger(harness, sessionId, (line) => console.log(line));

  let failed = false;
  if (navigateTarget !== undefined) {
    const targetId = navigateTarget === "root" ? null : navigateTarget;
    console.log(
      `[User][${sessionId}] (navigate to ${targetId ?? "root"}${summarize ? ", summarized" : ""}` +
        `${navigateLabel ? `, label="${navigateLabel}"` : ""})`,
    );
    const result = await lane.navigateTree(
      targetId,
      { summarize, ...(navigateLabel === undefined ? {} : { label: navigateLabel }) },
      context,
    );
    failed = logNavigationResult(result);
  } else {
    console.log(`[User][${sessionId}] ${prompt}`);
    const result = await lane.prompt(prompt as string, undefined, context);
    failed = logRunResult("Operation", result);
  }

  detachTrace();

  await printTree("after");

  await harness.close(context);
  await repo.close(context);

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
