import { createServer } from "node:net";

import type { Pool } from "pg";

import { ActionService, type ActionServiceOptions, type ActionView, type Clock, type StepResult } from "../src/action-service.js";
import { Checkpoints, type Fault } from "../src/checkpoints.js";
import { DeliveryWorker, type DeliveryWorkerOptions } from "../src/delivery-worker.js";
import { createPool, createSchema, databaseUrl, dropSchema, migrate, resetData, resetReceiver, throwawaySchemaName } from "../src/db.js";
import { PrincipalDirectory, loadTenantFixture } from "../src/directory.js";
import { ManualReview } from "../src/manual-review.js";
import { OutboxStore, type OutboxRow } from "../src/outbox.js";
import { Policy } from "../src/policy.js";
import { ReceiverClient } from "../src/receiver-client.js";
import type { ReceiverContract } from "../src/receiver/contract.js";
import { startReceiver, type RunningReceiver } from "../src/receiver/server.js";
import { mintSecurityContextForTest, type SecurityContext } from "../src/security-context.js";

export class FakeClock implements Clock {
  private current: number;

  public constructor(start = "2026-09-19T09:00:00.000Z") {
    this.current = new Date(start).getTime();
  }

  public now(): Date {
    return new Date(this.current);
  }

  public advance(ms: number): void {
    this.current += ms;
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

export const ctx = (tenantId: string, subject: string): SecurityContext =>
  mintSecurityContextForTest({ tenantId, subject, requestId: `req-${tenantId}-${subject}` });

export const alice = () => ctx("tenant-a", "alice"); // operator
export const bob = () => ctx("tenant-a", "bob"); // approver
export const carol = () => ctx("tenant-a", "carol"); // viewer
export const dave = () => ctx("tenant-a", "dave"); // operator + approver
export const erin = () => ctx("tenant-b", "erin"); // operator (tenant-b)
export const frank = () => ctx("tenant-b", "frank"); // approver (tenant-b)

/** The receiver contracts the tests exercise. Every effect guarantee is stated against one of these. */
export const CONTRACTS = {
  /** Idempotent by key, has status lookup. The receiver the lab's main guarantees are stated for. */
  keyAndLookup: { idempotency: "key", lookup: true, fencing: false },
  keyOnly: { idempotency: "key", lookup: false, fencing: false },
  lookupOnly: { idempotency: "none", lookup: true, fencing: false },
  /** A legacy API: no deduplication, no lookup. */
  neither: { idempotency: "none", lookup: false, fencing: false },
  /** Idempotent, has lookup, and also rejects stale fencing tokens at its write boundary. */
  keyLookupFencing: { idempotency: "key", lookup: true, fencing: true },
  /** No deduplication, but it rejects stale fencing tokens at its write boundary. */
  fencingOnly: { idempotency: "none", lookup: true, fencing: true },
} as const satisfies Record<string, ReceiverContract>;

/** A URL on a port nothing listens on (bound and released a moment ago), so connecting is refused. */
export async function refusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

export function must<T>(result: StepResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result.value;
}

export async function count(pool: Pool, table: string): Promise<number> {
  return Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
}

export async function booking(pool: Pool, tenantId: string, bookingNo: string): Promise<{ status: string; version: number }> {
  const { rows } = await pool.query<{ status: string; version: number }>("SELECT status, version FROM bookings WHERE tenant_id = $1 AND booking_no = $2", [tenantId, bookingNo]);
  return rows[0] as { status: string; version: number };
}

export async function receiverBooking(pool: Pool, tenantId: string, bookingNo: string): Promise<{ status: string; version: number }> {
  const { rows } = await pool.query<{ status: string; version: number }>("SELECT status, version FROM receiver_bookings WHERE tenant_id = $1 AND booking_no = $2", [tenantId, bookingNo]);
  return rows[0] as { status: string; version: number };
}

/** Business effects the receiver really applied (ground truth), optionally for one idempotency key. */
export async function receiverEffects(pool: Pool, key?: string): Promise<number> {
  return Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM receiver_effects WHERE ($1::text IS NULL OR request_ref = $1)", [key ?? null])).rows[0]?.n);
}

/** Requests that reached the receiver (delivery or lookup). */
export async function receiverRequests(pool: Pool, kind: "deliver" | "lookup", key?: string): Promise<number> {
  return Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM receiver_requests WHERE kind = $1 AND ($2::text IS NULL OR request_ref = $2)", [kind, key ?? null])).rows[0]?.n);
}

export interface TestEnv {
  url: string;
  appSchema: string;
  receiverSchema: string;
  pool: Pool;
  receiverPool: Pool;
  close(): Promise<void>;
}

/** Two migrated databases inside throwaway schemas: the application's and the receiver's. */
export async function startEnv(): Promise<TestEnv> {
  const url = databaseUrl(process.env.DATABASE_URL ? process.env : (await import("dotenv")).config({ quiet: true }).parsed ?? {});
  const appSchema = throwawaySchemaName("app");
  const receiverSchema = throwawaySchemaName("receiver");
  await createSchema(url, appSchema);
  await createSchema(url, receiverSchema);
  const pool = createPool(url, appSchema);
  const receiverPool = createPool(url, receiverSchema);
  await migrate(pool, "app");
  await migrate(receiverPool, "receiver");
  return {
    url,
    appSchema,
    receiverSchema,
    pool,
    receiverPool,
    async close() {
      await pool.end();
      await receiverPool.end();
      await dropSchema(url, appSchema);
      await dropSchema(url, receiverSchema);
    },
  };
}

export interface WorkerSpec {
  /** What this worker's application *assumes* about the receiver. Defaults to the receiver's real contract. */
  assumes?: ReceiverContract;
  checkpoints?: Checkpoints;
  leaseMs?: number;
  timeoutMs?: number;
  maxDeliveryAttempts?: number;
  maxReconcileAttempts?: number;
  baseUrl?: string;
}

/** Everything a test needs, wired: app service, outbox, manual review, a running receiver, and worker factories. */
export class Rig {
  public readonly clock = new FakeClock();
  public directory = new PrincipalDirectory(loadTenantFixture().principals);
  public service!: ActionService;
  public store!: OutboxStore;
  public review!: ManualReview;
  public receiver!: RunningReceiver;
  public receiverCheckpoints = new Checkpoints();
  public contract: ReceiverContract = CONTRACTS.keyAndLookup;
  private readonly fixture = loadTenantFixture();

  private constructor(public readonly env: TestEnv) {}

  public static async start(): Promise<Rig> {
    return new Rig(await startEnv());
  }

  public get pool(): Pool {
    return this.env.pool;
  }

  public get receiverPool(): Pool {
    return this.env.receiverPool;
  }

  /** Fresh data in both schemas and a fresh receiver with the given contract and faults. */
  public async reset(contract: ReceiverContract = CONTRACTS.keyAndLookup, receiverFaults: readonly Fault[] = [], serviceOptions: Partial<ActionServiceOptions> = {}): Promise<void> {
    await this.receiver?.close();
    this.directory = new PrincipalDirectory(loadTenantFixture().principals);
    await resetData(this.pool, this.fixture.bookings);
    await resetReceiver(this.receiverPool, this.fixture.bookings);
    this.contract = contract;
    this.receiverCheckpoints = new Checkpoints(receiverFaults);
    this.receiver = await startReceiver({ pool: this.receiverPool, contract, checkpoints: this.receiverCheckpoints });
    this.service = new ActionService({ pool: this.pool, policy: new Policy(this.directory), clock: this.clock, ...serviceOptions });
    this.store = new OutboxStore(this.pool, this.clock);
    this.review = new ManualReview(this.pool, new Policy(this.directory), this.clock);
  }

  public worker(id: string, spec: WorkerSpec = {}): DeliveryWorker {
    const options: DeliveryWorkerOptions = {
      workerId: id,
      pool: this.pool,
      clock: this.clock,
      client: new ReceiverClient({ baseUrl: spec.baseUrl ?? this.receiver.url, timeoutMs: spec.timeoutMs ?? 2_000 }),
      contract: spec.assumes ?? this.contract,
      leaseMs: spec.leaseMs ?? 30 * SECOND,
      ...(spec.maxDeliveryAttempts === undefined ? {} : { maxDeliveryAttempts: spec.maxDeliveryAttempts }),
      ...(spec.maxReconcileAttempts === undefined ? {} : { maxReconcileAttempts: spec.maxReconcileAttempts }),
      ...(spec.checkpoints === undefined ? {} : { checkpoints: spec.checkpoints }),
    };
    return new DeliveryWorker(options);
  }

  /** Propose → approve → admit for the booking, returning the admitted action and its outbox row. */
  public async admitted(bookingNo = "BK1001", newStatus = "on_hold", tenant: "a" | "b" = "a"): Promise<{ action: ActionView; row: OutboxRow }> {
    const [requester, approver] = tenant === "a" ? [alice(), bob()] : [erin(), frank()];
    const proposal = must(await this.service.propose(requester, { bookingNo, newStatus, reason: "customs hold" }));
    must(await this.service.approve(approver, proposal.id, { digest: proposal.digest }));
    const action = must(await this.service.admit(requester, proposal.id));
    const row = (await this.store.getByAction(action.id)) as OutboxRow;
    return { action, row };
  }

  public async close(): Promise<void> {
    await this.receiver?.close();
    await this.env.close();
  }
}
