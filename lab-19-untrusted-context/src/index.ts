import "dotenv/config";

import { ISSUER_KEYS_PATH, REGISTRY_PATH, SESSIONS_ROOT, createApp, modelBindingFromEnvironment } from "./app.js";

const PORT = Number(process.env.PORT ?? 3981);

const { server } = await createApp({
  binding: modelBindingFromEnvironment(),
  paths: { sessionsRoot: SESSIONS_ROOT, registryPath: REGISTRY_PATH },
  issuerKeysPath: ISSUER_KEYS_PATH,
  // Off by default: a trace line carries user text and tool arguments. Opt in with LAB19_TRACE=1 (synthetic data only).
  ...(process.env.LAB19_TRACE === "1" ? { trace: (line: string) => console.log(line) } : {}),
  onAuthFailure: (reason, requestId) => console.error(`[Auth] rejected requestId=${requestId} reason=${reason}`),
  onRunFailure: (detail, requestId) => console.error(`[Run] failed requestId=${requestId} detail=${detail}`),
});

server.listen(PORT, () => {
  console.log(`[Server] listening on http://localhost:${PORT} (local test issuer; POST /v1/chat, GET /v1/sessions/:id/messages, POST /v1/sessions/:id/compact)`);
});
