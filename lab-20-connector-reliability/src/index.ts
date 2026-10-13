import "dotenv/config";

import { ISSUER_KEYS_PATH, REGISTRY_PATH, SESSIONS_ROOT, createApp, modelBindingFromEnvironment } from "./app.js";
import { FakeBookingApi } from "./fake-api/server.js";
import { pricingFromEnvironment } from "./usage-meter.js";

const PORT = Number(process.env.PORT ?? 3982);
const API_PORT = Number(process.env.FAKE_API_PORT ?? 3983);

// The local fake booking API, in this process for convenience. Point BOOKING_API_URL at another
// server to exercise a different one (a real endpoint needs its own authorized integration check).
const fakeApi = new FakeBookingApi();
const baseUrl = process.env.BOOKING_API_URL ?? (await fakeApi.start(API_PORT));

const { server } = await createApp({
  binding: modelBindingFromEnvironment(),
  paths: { sessionsRoot: SESSIONS_ROOT, registryPath: REGISTRY_PATH },
  issuerKeysPath: ISSUER_KEYS_PATH,
  connector: { baseUrl },
  pricing: pricingFromEnvironment(),
  trace: (line) => console.log(line),
  onReport: (error) => console.error(`[Report] harness swallowed a failure: ${error instanceof Error ? error.message : String(error)}`),
  onAuthFailure: (reason, requestId) => console.error(`[Auth] rejected requestId=${requestId} reason=${reason}`),
  onRunFailure: (detail, requestId) => console.error(`[Run] failed requestId=${requestId} detail=${detail}`),
  onRunOutcome: (outcome, requestId) => console.log(`[Run] requestId=${requestId} outcome=${outcome}`),
});

server.listen(PORT, () => {
  console.log(`[Server] listening on http://localhost:${PORT} (booking API: ${baseUrl}; POST /v1/chat)`);
});
