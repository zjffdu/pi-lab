import "dotenv/config";

import { createInvestigationAgent, modelSelectionFromEnvironment } from "./create-agent.js";
import { createInvestigationTraceLogger } from "./investigation-trace-logger.js";

const DEFAULT_QUESTION =
  "Investigate booking BK1001: is there evidence of a departure delay, and what is the port congestion risk?";

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim() || DEFAULT_QUESTION;
  const selection = modelSelectionFromEnvironment();
  const agent = createInvestigationAgent(selection);

  console.log(`[Setup] model=${selection.provider}/${selection.modelId}`);
  console.log(`[User] ${question}`);

  agent.subscribe(createInvestigationTraceLogger((line) => console.log(line)));
  await agent.prompt(question);

  if (agent.state.errorMessage) {
    throw new Error(`Agent run failed: ${agent.state.errorMessage}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
