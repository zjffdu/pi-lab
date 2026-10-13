import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { assertModelAvailable, modelSelectionFromEnvironment } from "./create-harness.js";
import { FROZEN_EVALUATION_CASES, PROMPT_VERSION } from "./evaluation-cases.js";
import { defaultSessionsRoot, runFrozenCases } from "./evaluation-runner.js";
import { buildReport, printReportSummary, writeReport } from "./report.js";
import { SPAN_TREE_ATTRIBUTES } from "./span-attributes.js";
import { renderSpanTree } from "./span-tree.js";

const REPORT_PATH = fileURLToPath(new URL("../runtime-data/evaluation-report.json", import.meta.url));

interface CliArgs {
  repetitions: number;
  caseIds: string[] | undefined;
  trace: boolean;
  spans: boolean;
}

const USAGE = "Usage: npm run agent -- [--repetitions <n>] [--case <id> ...] [--trace] [--spans]";

function parseArgs(argv: string[]): CliArgs {
  let repetitions = 1;
  let caseIds: string[] | undefined;
  let trace = false;
  let spans = false;
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === "--repetitions") {
      repetitions = Number(argv[index + 1]);
      index += 2;
    } else if (flag === "--case") {
      caseIds = (caseIds ?? []).concat(argv[index + 1] as string);
      index += 2;
    } else if (flag === "--trace") {
      trace = true;
      index += 1;
    } else if (flag === "--spans") {
      spans = true;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${flag}". ${USAGE}`);
    }
  }
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error(`--repetitions must be a positive integer, got "${repetitions}". ${USAGE}`);
  }
  return { repetitions, caseIds, trace, spans };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = args.caseIds ? FROZEN_EVALUATION_CASES.filter((c) => args.caseIds?.includes(c.id)) : FROZEN_EVALUATION_CASES;
  if (cases.length === 0) {
    throw new Error(`No matching case(s). Known ids: ${FROZEN_EVALUATION_CASES.map((c) => c.id).join(", ")}`);
  }

  const models = builtinModels();
  const selection = modelSelectionFromEnvironment();
  assertModelAvailable(models, selection);
  const startedAt = new Date().toISOString();

  console.log(`[Run] model=${selection.provider}/${selection.modelId} cases=${cases.map((c) => c.id).join(",")} repetitions=${args.repetitions}`);

  const results = await runFrozenCases({
    cases,
    repetitions: args.repetitions,
    models,
    selection,
    sessionsRoot: defaultSessionsRoot(import.meta.url),
    ...(args.trace ? { trace: (line: string) => console.log(line) } : {}),
    onCaseComplete: (result) => {
      const failed = result.checks.filter((check) => check.status === "fail").map((check) => check.name);
      console.log(
        `[Case] ${result.caseId} rep=${result.repetition} status=${result.operationStatus} wallClockMs=${result.wallClockMs} ` +
          `failedChecks=${failed.length > 0 ? failed.join(",") : "none"}`,
      );
      if (args.spans) {
        for (const line of renderSpanTree(result.spans, SPAN_TREE_ATTRIBUTES)) console.log(`  ${line}`);
      }
    },
  });

  const report = buildReport(
    {
      modelProvider: selection.provider,
      modelId: selection.modelId,
      promptVersion: PROMPT_VERSION,
      caseIds: cases.map((c) => c.id),
      repetitions: args.repetitions,
      startedAt,
    },
    results,
  );

  printReportSummary(report);
  await writeReport(REPORT_PATH, report);
  console.log(`\n[Report] written to ${REPORT_PATH}`);

  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
