import { createEchoApp } from "./create-app.js";

const app = createEchoApp();

app.start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
