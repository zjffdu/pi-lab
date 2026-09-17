import "dotenv/config";

import { createPiAgentRunner } from "./agent-runner.js";
import { createBookingApp } from "./create-app.js";

const runner = createPiAgentRunner();
const app = createBookingApp(runner);

app.start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
