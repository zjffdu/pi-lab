import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type { Pool, PoolClient } from "pg";

import { noCheckpoints, type Checkpoints } from "../checkpoints.js";
import { requestHash } from "../idempotency.js";
import {
  DELIVER_PATH,
  FENCING_HEADER,
  IDEMPOTENCY_HEADER,
  parseDeliverRequest,
  type DeliverRequest,
  type DeliverResponse,
  type LookupResponse,
  type ReceiverContract,
} from "./contract.js";

export interface ReceiverOptions {
  /** The receiver's own pool (its own schema). It never shares a transaction with the application. */
  pool: Pool;
  contract: ReceiverContract;
  checkpoints?: Checkpoints;
}

export interface RunningReceiver {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 16 * 1024;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const send = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
};

type Applied = Extract<DeliverResponse, { result: "applied" }>;

/** The HTTP status a stored outcome is replayed with. */
const statusOf = (response: DeliverResponse): number => (response.result === "applied" ? 200 : response.code === "unknown_booking" ? 404 : 409);
type Outcome = { status: number; body: DeliverResponse; log: string };

/**
 * A stand-in for the downstream booking system.
 *
 * What it does, per `contract`:
 *  - `idempotency: "key"` — one transaction per request, serialized by an advisory lock on the key:
 *    replay the stored outcome if the key was seen, otherwise check the version precondition, apply,
 *    and store the outcome. A repeat can never apply a second effect.
 *  - `idempotency: "none"` — a legacy API: it applies every request it receives, with no version
 *    precondition, so the same request delivered twice really is applied twice. It logs the client's
 *    key on the effect row as `request_ref` so a receiver *with* lookup can still be asked.
 *  - `lookup` — whether `GET /v1/status-changes/:key` exists (otherwise 501).
 *  - `fencing` — a request carrying a fencing token lower than one already accepted for its key is
 *    refused with `stale_fence` before anything is applied.
 *
 * Its checkpoints (`receiver.before_apply`, `receiver.after_apply`) are where the failure
 * injections "slow", "fail before applying", and "applied but the response is lost" attach.
 */
export async function startReceiver(options: ReceiverOptions): Promise<RunningReceiver> {
  const { pool, contract } = options;
  const checkpoints = options.checkpoints ?? noCheckpoints;
  const sockets = new Set<Socket>();

  const logRequest = (client: Pool | PoolClient, ref: string | null, token: number | null, kind: "deliver" | "lookup", outcome: string) =>
    client.query("INSERT INTO receiver_requests (request_ref, fencing_token, kind, outcome, at) VALUES ($1, $2, $3, $4, $5)", [ref, token, kind, outcome, new Date()]);

  async function apply(client: PoolClient, request: DeliverRequest, ref: string | null, token: number | null): Promise<Outcome> {
    const booking = await client.query<{ status: string; version: number }>(
      "SELECT status, version FROM receiver_bookings WHERE tenant_id = $1 AND booking_no = $2 FOR UPDATE",
      [request.tenantId, request.bookingNo],
    );
    const current = booking.rows[0];
    if (!current) return { status: 404, body: { result: "rejected", code: "unknown_booking" }, log: "rejected" };
    if (contract.idempotency === "key" && current.version !== request.expectedVersion) {
      return { status: 409, body: { result: "rejected", code: "version_conflict" }, log: "rejected" };
    }
    const toVersion = current.version + 1;
    await client.query("UPDATE receiver_bookings SET status = $3, version = $4 WHERE tenant_id = $1 AND booking_no = $2", [request.tenantId, request.bookingNo, request.newStatus, toVersion]);
    const effect = await client.query<{ id: string }>(
      `INSERT INTO receiver_effects (request_ref, tenant_id, booking_no, from_status, to_status, from_version, to_version, fencing_token, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [ref, request.tenantId, request.bookingNo, current.status, request.newStatus, current.version, toVersion, token, new Date()],
    );
    const body: Applied = { result: "applied", replayed: false, effectId: Number(effect.rows[0]?.id), bookingNo: request.bookingNo, newStatus: request.newStatus, toVersion };
    return { status: 200, body, log: "applied" };
  }

  async function handleDeliver(request: DeliverRequest, ref: string | null, token: number | null): Promise<Outcome> {
    if (contract.idempotency === "key" && ref === null) return { status: 400, body: { result: "rejected", code: "missing_idempotency_key" }, log: "rejected" };
    if (contract.fencing && (ref === null || token === null)) return { status: 400, body: { result: "rejected", code: "missing_fencing_token" }, log: "rejected" };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (ref !== null && (contract.idempotency === "key" || contract.fencing)) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ref]);
      }
      if (contract.fencing && ref !== null && token !== null) {
        const fence = await client.query<{ max_token: string }>("SELECT max_token FROM receiver_fences WHERE idempotency_key = $1", [ref]);
        const max = fence.rows[0] ? Number(fence.rows[0].max_token) : undefined;
        if (max !== undefined && token < max) {
          await logRequest(client, ref, token, "deliver", "stale_fence");
          await client.query("COMMIT");
          return { status: 409, body: { result: "rejected", code: "stale_fence" }, log: "stale_fence" };
        }
        await client.query(
          "INSERT INTO receiver_fences (idempotency_key, max_token) VALUES ($1, $2) ON CONFLICT (idempotency_key) DO UPDATE SET max_token = GREATEST(receiver_fences.max_token, EXCLUDED.max_token)",
          [ref, token],
        );
      }

      let outcome: Outcome;
      const hash = requestHash(request);
      if (contract.idempotency === "key" && ref !== null) {
        const seen = await client.query<{ request_hash: string; outcome: string; response: DeliverResponse }>(
          "SELECT request_hash, outcome, response FROM receiver_keys WHERE idempotency_key = $1",
          [ref],
        );
        const previous = seen.rows[0];
        if (previous && previous.request_hash !== hash) {
          outcome = { status: 422, body: { result: "rejected", code: "idempotency_key_reuse" }, log: "key_reuse" };
        } else if (previous) {
          const replay: DeliverResponse = previous.response.result === "applied" ? { ...previous.response, replayed: true } : previous.response;
          outcome = { status: statusOf(previous.response), body: replay, log: "replayed" };
        } else {
          outcome = await apply(client, request, ref, token);
          // Every outcome `apply` produces is recorded (applied, version conflict, unknown booking), so a
          // lookup can report a definitive refusal instead of "no record".
          {
            await client.query("INSERT INTO receiver_keys (idempotency_key, request_hash, outcome, response, created_at) VALUES ($1, $2, $3, $4, $5)", [
              ref,
              hash,
              outcome.body.result,
              JSON.stringify(outcome.body),
              new Date(),
            ]);
          }
        }
      } else {
        outcome = await apply(client, request, ref, token);
      }
      await logRequest(client, ref, token, "deliver", outcome.log);
      await client.query("COMMIT");
      return outcome;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function handleLookup(key: string): Promise<{ status: number; body: unknown }> {
    if (!contract.lookup) return { status: 501, body: { error: "lookup_not_supported" } };
    let body: LookupResponse;
    if (contract.idempotency === "key") {
      const { rows } = await pool.query<{ outcome: string; response: DeliverResponse }>("SELECT outcome, response FROM receiver_keys WHERE idempotency_key = $1", [key]);
      const found = rows[0];
      if (!found) body = { state: "not_found" };
      else if (found.response.result === "applied") body = { state: "applied", bookingNo: found.response.bookingNo, newStatus: found.response.newStatus, toVersion: found.response.toVersion, effectCount: 1 };
      else body = { state: "rejected", code: found.response.code };
    } else {
      const { rows } = await pool.query<{ booking_no: string; to_status: string; to_version: number; n: string }>(
        `SELECT booking_no, to_status, to_version, count(*) OVER () AS n FROM receiver_effects WHERE request_ref = $1 ORDER BY id DESC LIMIT 1`,
        [key],
      );
      const found = rows[0];
      body = found ? { state: "applied", bookingNo: found.booking_no, newStatus: found.to_status, toVersion: found.to_version, effectCount: Number(found.n) } : { state: "not_found" };
    }
    await logRequest(pool, key, null, "lookup", body.state);
    return { status: 200, body };
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://receiver.local");
        if (request.method === "POST" && url.pathname === DELIVER_PATH) {
          const parsed = parseDeliverRequest(JSON.parse(await readBody(request)));
          if (!parsed) return send(response, 400, { result: "rejected", code: "invalid_request" });
          const ref = request.headers[IDEMPOTENCY_HEADER];
          const tokenHeader = request.headers[FENCING_HEADER];
          const key = typeof ref === "string" && ref !== "" ? ref : null;
          const token = typeof tokenHeader === "string" && /^\d+$/.test(tokenHeader) ? Number(tokenHeader) : null;

          const before = await checkpoints.hit("receiver.before_apply", { key: key ?? "" });
          if (before?.kind === "drop") return request.socket.destroy();
          if (before?.kind === "http") {
            await logRequest(pool, key, token, "deliver", `fault_${before.status}`);
            return send(response, before.status, { error: "injected_fault" });
          }

          const outcome = await handleDeliver(parsed, key, token);
          const after = await checkpoints.hit("receiver.after_apply", { key: key ?? "" });
          if (after?.kind === "drop") return request.socket.destroy();
          if (after?.kind === "http") return send(response, after.status, { error: "injected_fault" });
          return send(response, outcome.status, outcome.body);
        }
        const lookup = /^\/v1\/status-changes\/([^/]+)$/.exec(url.pathname);
        if (request.method === "GET" && lookup?.[1]) {
          const result = await handleLookup(decodeURIComponent(lookup[1]));
          return send(response, result.status, result.body);
        }
        return send(response, 404, { error: "no_such_route" });
      } catch (error) {
        return send(response, 500, { error: "receiver_error", message: error instanceof Error ? error.message : "unknown" });
      }
    })();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
