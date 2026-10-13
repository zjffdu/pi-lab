import "dotenv/config";

import { ISSUER_KEYS_PATH, REGISTRY_PATH, SESSIONS_ROOT, createApp, modelBindingFromEnvironment } from "./app.js";
import { createPool, databaseUrl, migrate, seedBookings } from "./db.js";
import { loadTenantFixture } from "./directory.js";

const PORT = Number(process.env.PORT ?? 3980);

const pool = createPool(databaseUrl());
const applied = await migrate(pool);
await seedBookings(pool, loadTenantFixture().bookings);
if (applied.length > 0) console.log(`[DB] applied migrations: ${applied.join(", ")}`);

const { server } = await createApp({
  binding: modelBindingFromEnvironment(),
  pool,
  sessionsRoot: SESSIONS_ROOT,
  registryPath: REGISTRY_PATH,
  issuerKeysPath: ISSUER_KEYS_PATH,
  // Off by default: a trace line carries user text and tool arguments. Opt in with LAB18_TRACE=1 (synthetic data only).
  ...(process.env.LAB18_TRACE === "1" ? { trace: (line: string) => console.log(line) } : {}),
  onAuthFailure: (reason, requestId) => console.error(`[Auth] rejected requestId=${requestId} reason=${reason}`),
  onRunFailure: (detail, requestId) => console.error(`[Run] failed requestId=${requestId} detail=${detail}`),
});

server.listen(PORT, () => {
  console.log(`[Server] listening on http://localhost:${PORT} (POST /v1/chat; GET /v1/actions[/:id]; POST /v1/actions/:id/{approve,reject,revoke,execute})`);
});
