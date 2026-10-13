import { config } from "dotenv";

import { Checkpoints, faultsFromEnvironment } from "../src/checkpoints.js";
import { createPool, databaseUrl } from "../src/db.js";
import { DeliveryWorker } from "../src/delivery-worker.js";
import { OutboxStore } from "../src/outbox.js";
import { ReceiverClient } from "../src/receiver-client.js";
import type { ReceiverContract } from "../src/receiver/contract.js";
import { systemClock } from "../src/action-service.js";

/**
 * A delivery worker as its own OS process, for the multi-worker experiment. Configured entirely by
 * environment variables so a parent (a test, or the demo) can start several and kill one:
 *
 *   APP_SCHEMA, RECEIVER_URL, WORKER_ID     required
 *   LEASE_MS, TIMEOUT_MS, POLL_MS           optional (defaults 30000 / 1000 / 100)
 *   CONTRACT                                JSON ReceiverContract this worker assumes
 *   FAULTS                                  JSON array of { at, action } for named checkpoints
 *   START_AT                                epoch ms: wait until then, so several workers start together
 *   MAX_RUN_MS                              give up after this long (default 60000)
 *
 * It exits 0 once no outbox row is pending, in flight, or unknown. `kill` faults end it with SIGKILL.
 */
config({ quiet: true });
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const workerId = need("WORKER_ID");
const pool = createPool(databaseUrl(), need("APP_SCHEMA"), 4);
const contract = JSON.parse(need("CONTRACT")) as ReceiverContract;
const store = new OutboxStore(pool, systemClock);
const worker = new DeliveryWorker({
  workerId,
  pool,
  clock: systemClock,
  client: new ReceiverClient({ baseUrl: need("RECEIVER_URL"), timeoutMs: Number(process.env.TIMEOUT_MS ?? 1_000) }),
  contract,
  leaseMs: Number(process.env.LEASE_MS ?? 30_000),
  backoff: { baseMs: 50, capMs: 200 },
  checkpoints: new Checkpoints(faultsFromEnvironment(process.env.FAULTS)),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const startAt = Number(process.env.START_AT ?? 0);
if (startAt > Date.now()) await sleep(startAt - Date.now());

const deadline = Date.now() + Number(process.env.MAX_RUN_MS ?? 60_000);
let worked = 0;
while (Date.now() < deadline) {
  const step = await worker.runOnce();
  if (step.kind === "worked") {
    worked += 1;
    continue;
  }
  if ((await store.openCount()) === 0) break;
  await sleep(Number(process.env.POLL_MS ?? 100));
}
console.log(JSON.stringify({ worker: workerId, worked }));
await pool.end();
