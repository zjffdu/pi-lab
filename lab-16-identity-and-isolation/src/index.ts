import "dotenv/config";

import { ISSUER_KEYS_PATH, REGISTRY_PATH, SESSIONS_ROOT, createApp, modelBindingFromEnvironment } from "./app.js";

const PORT = Number(process.env.PORT ?? 3979);

const { server } = await createApp({
  binding: modelBindingFromEnvironment(),
  paths: { sessionsRoot: SESSIONS_ROOT, registryPath: REGISTRY_PATH },
  issuerKeysPath: ISSUER_KEYS_PATH,
  // One run/turn/tool tree per request, tagged req=/tenant=/sub=. Message text is redacted (length only):
  // this log is shared by every tenant's operators. Set TRACE_TEXT=full to print it, for synthetic data only.
  trace: (line) => console.log(line),
  traceText: process.env.TRACE_TEXT === "full" ? "full" : "redacted",
  onAuthFailure: (reason, requestId) => console.error(`[Auth] rejected requestId=${requestId} reason=${reason}`),
  onRunFailure: (detail, requestId) => console.error(`[Run] failed requestId=${requestId} detail=${detail}`),
});

server.listen(PORT, () => {
  console.log(`[Server] listening on http://localhost:${PORT} (local test issuer; POST /v1/chat, GET /v1/sessions/:id/messages)`);
});
