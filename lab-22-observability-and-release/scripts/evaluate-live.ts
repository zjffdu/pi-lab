import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";

import { loadAllCases } from "../src/case-registry.js";
import { createTraceLogger } from "../src/agent-trace-logger.js";
import { createJudgeAgent, modelSelectionFromEnvironment } from "../src/create-agent.js";
import { deterministicRubricJudge } from "../src/judge.js";
import { buildJudgePrompt, judgeWithAgent } from "../src/live-judge.js";
import { runCases } from "../src/runner.js";

/**
 * The roadmap's "bounded live evaluation" layer: a real model scores each held-out case's answer
 * against its rubric, for the cases that declare one. Deliberately not part of `npm run check` or
 * `npm run release-gate` — those stay deterministic. Guarded by an explicit env var so it is never
 * run by accident (it spends real API budget).
 */
if (process.env.ALLOW_LIVE_EVAL !== "1") {
  console.error("Refusing to run: this calls a live model. Set ALLOW_LIVE_EVAL=1 to proceed.");
  process.exit(2);
}

async function main(): Promise<void> {
  const selection = modelSelectionFromEnvironment();
  const cases = loadAllCases().filter((kase) => kase.semantic !== undefined);
  const results = runCases(cases).map((output) => output.record.result);

  const rows: Array<{ caseId: string; liveScore: number | undefined; deterministicFraction: number; rawResponse: string }> = [];

  for (const kase of cases) {
    const result = results.find((entry) => entry.caseId === kase.id);
    if (!result || !kase.semantic) continue;
    const prompt = buildJudgePrompt(kase, result);
    if (!prompt) continue;
    const agent = createJudgeAgent(selection);
    console.log(`\n[judge] ${kase.id}`);
    agent.subscribe(createTraceLogger((line) => console.log(`  ${line}`)));
    const judged = await judgeWithAgent(agent, prompt);
    const deterministic = deterministicRubricJudge(kase, result);
    rows.push({
      caseId: kase.id,
      liveScore: judged.liveScore,
      deterministicFraction: deterministic.score / deterministic.maxScore,
      rawResponse: judged.errorMessage ? `provider_error: ${judged.errorMessage}` : judged.rawResponse,
    });
  }

  for (const row of rows) {
    const liveFraction = row.liveScore === undefined ? undefined : row.liveScore / 3;
    console.log(`${row.caseId}: live=${row.liveScore ?? "unavailable"} (${liveFraction?.toFixed(2) ?? "n/a"}) deterministic=${row.deterministicFraction.toFixed(2)} raw="${row.rawResponse}"`);
  }

  mkdirSync("runtime-evidence", { recursive: true });
  const path = `runtime-evidence/live-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(path, `${JSON.stringify({ model: selection, rows }, null, 2)}\n`, "utf8");
  console.log(`[evaluate-live] wrote ${path}`);
}

main().catch((error: unknown) => {
  console.error(`[Fatal] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
