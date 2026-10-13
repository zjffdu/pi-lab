import { defineConfig } from "vitest/config";

// The database tests talk to Postgres in a container VM and some wait on real timers (a slow
// receiver, a killed child process), so the default 5 s per test is too tight.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
