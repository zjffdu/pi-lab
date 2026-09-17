import "dotenv/config";

import { createBookingAgent, modelSelectionFromEnvironment } from "./create-agent.js";
import { createTraceLogger } from "./trace-logger.js";

const DEFAULT_QUESTION = "What are the details for booking BK1001?";

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim() || DEFAULT_QUESTION;
  const selection = modelSelectionFromEnvironment();
  const agent = createBookingAgent(selection);

  console.log(`[Setup] model=${selection.provider}/${selection.modelId}`);
  console.log(`[User] ${question}`);

  agent.subscribe(createTraceLogger((line) => console.log(line)));
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
