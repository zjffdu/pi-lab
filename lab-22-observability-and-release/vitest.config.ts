import { defineConfig } from "vitest/config";

// The drain and shutdown-while-active tests wait on real timers around a controllable in-flight
// run, so the default 5 s per test is tight under load.
export default defineConfig({
  test: { testTimeout: 20_000, hookTimeout: 20_000 },
});
