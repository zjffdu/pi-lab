import { DrainController, DrainInProgressError } from "../src/drain.js";

/**
 * Demonstrates the `shutdown-while-work-is-active` failure injection: a run started before
 * `drain()` is called must still finish; a run attempted after drain has begun must be rejected
 * immediately rather than silently queued and lost.
 */
function slowUnitOfWork(label: string, ms: number): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve(`${label} done`), ms));
}

async function main(): Promise<void> {
  const controller = new DrainController();

  console.log("[drain-demo] starting an in-flight run (400ms)");
  const inFlight = controller.track(slowUnitOfWork("in-flight-run", 400));

  console.log(`[drain-demo] calling drain() while ${controller.inFlightCount()} run is in flight`);
  const draining = controller.drain();

  console.log("[drain-demo] attempting a NEW run after drain() has started");
  try {
    controller.track(slowUnitOfWork("late-run", 10));
    console.log("[drain-demo] UNEXPECTED: late run was accepted");
  } catch (error) {
    console.log(`[drain-demo] correctly rejected: ${error instanceof DrainInProgressError ? error.message : String(error)}`);
  }

  const result = await inFlight;
  console.log(`[drain-demo] in-flight run completed: ${result}`);
  await draining;
  console.log("[drain-demo] drain() resolved only after the in-flight run finished — no interrupted work, no rejected-but-lost work.");
}

main();
