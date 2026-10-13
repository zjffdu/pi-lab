import { Checkpoints, SimulatedCrash, type Fault } from "../src/checkpoints.js";
import { buildEffectReport, type EffectReport } from "../src/report.js";
import type { ReceiverContract } from "../src/receiver/contract.js";
import { CONTRACTS, Rig, SECOND } from "../tests/db-helpers.js";

/**
 * Scenario table for Lab 21, on throwaway schemas (nothing persists). Each row runs one failure injection
 * through the real outbox, worker, and receiver, then prints the three layers separately:
 * attempts, business effects at the receiver, and the application's durable result.
 *
 * WORKSHEET.md asks for a prediction first. Record it (or write `waived`) before running this: the table
 * is the answer to both prediction questions.
 */
const LEASE = 30 * SECOND;

interface Scenario {
  name: string;
  contract: ReceiverContract;
  faults: Fault[];
  run(rig: Rig): Promise<string>;
}

const scenarios: Scenario[] = [
  {
    name: "A1  response lost after the receiver succeeded",
    contract: CONTRACTS.keyAndLookup,
    faults: [{ at: "receiver.after_apply", action: { kind: "drop" } }],
    async run(rig) {
      const { action } = await rig.admitted();
      const worker = rig.worker("w1");
      await worker.runOnce();
      const mid = (await buildEffectReport(rig.pool, rig.receiverPool, action.id))?.durableResult.outboxStatus;
      rig.clock.advance(5 * SECOND);
      await worker.runUntilIdle();
      return `${action.id}|after first attempt the application recorded: ${mid}`;
    },
  },
  {
    name: "A2  timeout while the receiver is slow (idempotent receiver)",
    contract: CONTRACTS.keyAndLookup,
    faults: [{ at: "receiver.before_apply", action: { kind: "delay", ms: 1200 } }],
    async run(rig) {
      const { action } = await rig.admitted();
      const worker = rig.worker("w1", { timeoutMs: 400 });
      await worker.runOnce();
      rig.clock.advance(5 * SECOND);
      await worker.runUntilIdle();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return action.id;
    },
  },
  {
    name: "A3  timeout while the receiver is slow (no idempotency, has lookup)",
    contract: CONTRACTS.lookupOnly,
    faults: [{ at: "receiver.before_apply", action: { kind: "delay", ms: 1200 } }],
    async run(rig) {
      const { action } = await rig.admitted();
      const worker = rig.worker("w1", { timeoutMs: 400 });
      await worker.runOnce();
      rig.clock.advance(5 * SECOND);
      await worker.runUntilIdle();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return action.id;
    },
  },
  {
    name: "A4  worker crashes before recording the result",
    contract: CONTRACTS.keyAndLookup,
    faults: [],
    async run(rig) {
      const { action } = await rig.admitted();
      const crash = new Checkpoints([{ at: "worker.before_result_commit", action: { kind: "crash" } }]);
      await rig.worker("w-crash", { checkpoints: crash, leaseMs: LEASE }).runOnce().catch((error: unknown) => {
        if (!(error instanceof SimulatedCrash)) throw error;
      });
      rig.clock.advance(LEASE + 1);
      await rig.worker("w-rescue", { leaseMs: LEASE }).runUntilIdle();
      return action.id;
    },
  },
  {
    name: "B1  old worker returns after its lease expired",
    contract: CONTRACTS.keyAndLookup,
    faults: [],
    async run(rig) {
      const { action } = await rig.admitted();
      const pause = new Checkpoints([{ at: "worker.before_result_commit", action: { kind: "pause" } }]);
      const old = rig.worker("old", { checkpoints: pause, leaseMs: LEASE });
      const stalled = old.runOnce();
      await pause.waitUntilPaused("worker.before_result_commit");
      rig.clock.advance(LEASE + 1);
      await rig.worker("new", { leaseMs: LEASE }).runUntilIdle();
      pause.release("worker.before_result_commit");
      await stalled;
      return action.id;
    },
  },
  {
    name: "C1  receiver with neither idempotency nor lookup",
    contract: CONTRACTS.neither,
    faults: [{ at: "receiver.after_apply", action: { kind: "drop" } }],
    async run(rig) {
      const { action } = await rig.admitted();
      const worker = rig.worker("w1");
      await worker.runOnce();
      rig.clock.advance(60 * SECOND);
      await worker.runUntilIdle();
      return action.id;
    },
  },
];

const cell = (value: unknown, width: number) => String(value).padEnd(width).slice(0, width);
const rig = await Rig.start();
const rows: string[] = [];
try {
  for (const scenario of scenarios) {
    await rig.reset(scenario.contract, scenario.faults);
    const note = await scenario.run(rig);
    const actionId = note.split("|")[0] as string;
    const report = (await buildEffectReport(rig.pool, rig.receiverPool, actionId)) as EffectReport;
    rows.push(
      [
        cell(scenario.name, 66),
        cell(`claims ${report.attempts.deliveryClaims}+${report.attempts.reconcileClaims}, receiver saw ${report.attempts.receiverSawRequests}`, 32),
        cell(`effects ${report.businessEffects.appliedCount}`, 10),
        cell(`${report.durableResult.outboxStatus}${report.durableResult.reviewReason ? ` (${report.durableResult.reviewReason})` : ""}`, 62),
        report.consistent ? "consistent" : `INCONSISTENT: ${report.inconsistency}`,
      ].join(" | "),
    );
  }
} finally {
  await rig.close();
}
console.log(["scenario".padEnd(66), "attempts".padEnd(32), "effects".padEnd(10), "durable result".padEnd(62), "check"].join(" | "));
for (const row of rows) console.log(row);
