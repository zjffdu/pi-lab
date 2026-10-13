import "dotenv/config";

import { fileURLToPath } from "node:url";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { assertModelAvailable, modelSelectionFromEnvironment } from "../src/create-harness.js";
import {
  duplicateEffects,
  requiredToolEvidence,
  spanCoverageChecks,
  UNOBSERVABLE,
  type CaseRunEvidence,
} from "../src/deterministic-checks.js";
import { FROZEN_EVALUATION_CASES, PROMPT_VERSION } from "../src/evaluation-cases.js";
import { defaultSessionsRoot, runFrozenCases, type CaseRunResult } from "../src/evaluation-runner.js";
import { buildReport, printReportSummary, writeReport } from "../src/report.js";
import { judgeAnswer, judgeSelectionFromEnvironment } from "../src/semantic-judge.js";
import { SPAN_TREE_ATTRIBUTES } from "../src/span-attributes.js";
import { renderSpanTree } from "../src/span-tree.js";

const REPETITIONS = 2;
const REPORT_PATH = fileURLToPath(new URL("../runtime-data/evaluation-demo-report.json", import.meta.url));

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function evidenceOf(result: CaseRunResult): CaseRunEvidence {
  return { answerText: result.answerText, operationStatus: result.operationStatus, toolCalls: result.toolCalls, spans: result.spans };
}

function findResult(results: readonly CaseRunResult[], caseId: string, repetition = 0): CaseRunResult {
  const found = results.find((r) => r.caseId === caseId && r.repetition === repetition);
  if (!found) throw new Error(`no result for ${caseId} rep=${repetition}`);
  return found;
}

async function main(): Promise<void> {
  const models = builtinModels();
  const selection = modelSelectionFromEnvironment();
  assertModelAvailable(models, selection);
  const startedAt = new Date().toISOString();

  console.log(
    `\n########## Lab 14 bounded live comparison: model=${selection.provider}/${selection.modelId} ` +
      `promptVersion=${PROMPT_VERSION} cases=${FROZEN_EVALUATION_CASES.length} repetitions=${REPETITIONS} ##########`,
  );

  // ---------------------------------------------------------------------------------------------
  // Part 1: every frozen case REPETITIONS times, against a fresh fixture and storage each time. Every
  // check is graded against durable and telemetry evidence, never against how confident the model's
  // prose sounds. The trace prints the model's request and Pi's execution as separate lines.
  // ---------------------------------------------------------------------------------------------
  const results = await runFrozenCases({
    cases: FROZEN_EVALUATION_CASES,
    repetitions: REPETITIONS,
    models,
    selection,
    sessionsRoot: defaultSessionsRoot(import.meta.url),
    trace: (line) => console.log(line),
    onCaseComplete: (result) => {
      const failed = result.checks.filter((check) => check.status === "fail").map((check) => check.name);
      console.log(
        `[Case] ${result.caseId} rep=${result.repetition} status=${result.operationStatus} wallClockMs=${result.wallClockMs} ` +
          `failedChecks=${failed.length > 0 ? failed.join(",") : "none"}\n`,
      );
    },
  });

  assert(results.length === FROZEN_EVALUATION_CASES.length * REPETITIONS, `expected ${FROZEN_EVALUATION_CASES.length * REPETITIONS} results, got ${results.length}`);
  for (const result of results) {
    assert(result.operationStatus === "done", `${result.caseId} rep=${result.repetition}: expected submission status done, got ${result.operationStatus}`);
    assert(result.spans.every((span) => span.settled), `${result.caseId} rep=${result.repetition}: a span was left unsettled`);
    assert(result.telemetryWarnings.length === 0, `${result.caseId} rep=${result.repetition}: bridge warnings: ${result.telemetryWarnings.join("; ")}`);
  }

  const report = buildReport(
    { modelProvider: selection.provider, modelId: selection.modelId, promptVersion: PROMPT_VERSION, caseIds: FROZEN_EVALUATION_CASES.map((c) => c.id), repetitions: REPETITIONS, startedAt },
    results,
  );
  printReportSummary(report);

  console.log("\n########## One run's span capture (the telemetry side of the trace above) ##########");
  for (const line of renderSpanTree(findResult(results, "list-containers").spans, SPAN_TREE_ATTRIBUTES)) console.log(line);

  // ---------------------------------------------------------------------------------------------
  // Part 2: the roadmap's failure injections, applied to REAL evidence captured in Part 1. Each proves
  // a deterministic check catches exactly the failure the roadmap names, on the shape of evidence a
  // live run actually produces. (tests/evaluation-runner.test.ts proves the same failures on scripted
  // runs, where the model can be made to misbehave on demand.)
  // ---------------------------------------------------------------------------------------------
  console.log("\n########## Failure injections (applied to real captured evidence) ##########");

  {
    const lookupCase = FROZEN_EVALUATION_CASES.find((c) => c.id === "lookup-single")!;
    const real = evidenceOf(findResult(results, "lookup-single"));
    assert(requiredToolEvidence(lookupCase, real).status === "pass", "sanity: the real run should have queried BK1001");
    const stripped: CaseRunEvidence = { ...real, toolCalls: real.toolCalls.filter((call) => call.toolName !== "get_booking") };
    const check = requiredToolEvidence(lookupCase, stripped);
    assert(check.status === "fail", "removing the required get_booking call must fail required-tool-evidence");
    console.log(`[Injection] missing required tool result -> required-tool-evidence: ${check.status} (${check.detail})`);
  }

  {
    const statusChangeCase = FROZEN_EVALUATION_CASES.find((c) => c.id === "status-change")!;
    const real = evidenceOf(findResult(results, "status-change"));
    assert(duplicateEffects(statusChangeCase, real).status === "pass", "sanity: the real run should show exactly one executed effect");
    const executed = real.toolCalls.find((call) => call.toolName === "update_booking_status" && !call.isError);
    assert(Boolean(executed), "sanity: a real update_booking_status execution must exist to duplicate");
    const doubled: CaseRunEvidence = { ...real, toolCalls: [...real.toolCalls, { ...executed!, toolCallId: `${executed!.toolCallId}-duplicate` }] };
    const check = duplicateEffects(statusChangeCase, doubled);
    assert(check.status === "fail", "a duplicated effect must fail duplicate-effects");
    console.log(`[Injection] duplicated local effect -> duplicate-effects: ${check.status} (${check.detail})`);
  }

  {
    const real = evidenceOf(findResult(results, "lookup-single"));
    const withoutRun: CaseRunEvidence = { ...real, spans: real.spans.filter((span) => span.name !== "lab.run") };
    const checks = spanCoverageChecks(withoutRun, ["lab.run"]);
    const runCheck = checks.find((c) => c.name === "span:lab.run")!;
    assert(runCheck.status === "fail", "removing the lab.run span must fail its coverage check, not silently pass");
    const unobservable = checks.filter((c) => c.name.startsWith("unobservable:"));
    assert(unobservable.length === UNOBSERVABLE.length && unobservable.every((c) => c.status === "unavailable"), "what the stream cannot show must report unavailable, not fail");
    console.log(`[Injection] missing expected span -> span:lab.run: ${runCheck.status}; ${unobservable.map((c) => c.name).join(", ")}: unavailable (never fail)`);
  }

  // ---------------------------------------------------------------------------------------------
  // Part 3: semantic answer quality — bounded to ONE case, ONE repetition, one isolated model call, kept
  // entirely separate from the deterministic verdicts above.
  // ---------------------------------------------------------------------------------------------
  console.log("\n########## Semantic judge (bounded: one case, one repetition) ##########");
  {
    const judged = findResult(results, "lookup-single");
    const judgment = await judgeAnswer({
      caseId: judged.caseId,
      repetition: judged.repetition,
      prompt: judged.prompt,
      answerText: judged.answerText,
      models,
      selection: judgeSelectionFromEnvironment(),
    });
    console.log(`[Judge] model=${judgment.judgeProvider}/${judgment.judgeModelId} case=${judgment.caseId} score=${judgment.score ?? "unparseable"} rationale=${JSON.stringify(judgment.rationale)}`);
    assert(judgment.score !== undefined, `semantic judge produced an unparseable rating for ${judgment.caseId}: raw=${judgment.raw}`);
  }

  await writeReport(REPORT_PATH, report);
  console.log(`\n[Report] written to ${REPORT_PATH}`);
  console.log("\n=== All Lab 14 telemetry-evaluation assertions passed ===");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
