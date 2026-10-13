import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { errors, jwtVerify, type CryptoKey } from "jose";

import type { BookingStore } from "./booking-store.js";
import { ASSISTANT_CLIENT_ID, DELEGATION_ALGORITHM, DELEGATION_ISSUER, DOWNSTREAM_AUDIENCE, SCOPE_WRITE } from "./delegation.js";

export type DownstreamOutcome =
  | "applied"
  | "invalid_token"
  | "wrong_audience"
  | "expired"
  | "delegation_required"
  | "insufficient_scope"
  | "not_found"
  | "conflict"
  | "bad_request";

/** One row per request the downstream handled. Contains no token, only what was decided. */
export interface DownstreamLogEntry {
  outcome: DownstreamOutcome;
  sub?: string;
  tid?: string;
  scope?: string;
  bookingNo?: string;
}

export interface DownstreamServiceOptions {
  store: BookingStore;
  publicKey: CryptoKey;
}

const STATUS_FOR: Record<DownstreamOutcome, number> = {
  applied: 200,
  invalid_token: 401,
  wrong_audience: 401,
  expired: 401,
  delegation_required: 403,
  insufficient_scope: 403,
  not_found: 404,
  conflict: 409,
  bad_request: 400,
};

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * A stand-in for a separate booking system with its own trust decisions. It authenticates the
 * *delegated token*, not the application: signature, issuer, audience, expiry, an `act` claim
 * naming the assistant, and the `bookings.write` scope. It then re-checks tenant and ownership
 * using `tid`/`sub` from that token — a second, independent enforcement point, so an application
 * bug that mis-decides still cannot act on a resource the *user* could not.
 *
 * It answers "no such booking" for both a missing booking and someone else's, and refuses a
 * change when the status differs from what the caller expected (a lost race between the
 * application's decision and this write).
 */
export class DownstreamBookingService {
  public readonly log: DownstreamLogEntry[] = [];
  private readonly server: Server;

  public constructor(private readonly options: DownstreamServiceOptions) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => this.respond(response, "bad_request", { error: "bad_request" }));
    });
  }

  public async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  public async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private respond(response: ServerResponse, outcome: DownstreamOutcome, body: unknown, entry: Omit<DownstreamLogEntry, "outcome"> = {}): void {
    this.log.push({ outcome, ...entry });
    response.writeHead(STATUS_FOR[outcome], { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const match = /^\/bookings\/([^/]+)\/status$/.exec(request.url ?? "");
    if (request.method !== "POST" || !match?.[1]) return this.respond(response, "bad_request", { error: "bad_request" });
    const bookingNo = decodeURIComponent(match[1]);

    const header = request.headers.authorization;
    const bearer = typeof header === "string" ? /^Bearer ([^\s]+)$/.exec(header)?.[1] : undefined;
    if (!bearer) return this.respond(response, "invalid_token", { error: "invalid_token" }, { bookingNo });

    let payload;
    try {
      ({ payload } = await jwtVerify(bearer, this.options.publicKey, {
        issuer: DELEGATION_ISSUER,
        audience: DOWNSTREAM_AUDIENCE,
        algorithms: [DELEGATION_ALGORITHM],
        requiredClaims: ["sub", "tid", "exp", "scope"],
      }));
    } catch (error) {
      const outcome: DownstreamOutcome =
        error instanceof errors.JWTExpired ? "expired" : error instanceof errors.JWTClaimValidationFailed && error.claim === "aud" ? "wrong_audience" : "invalid_token";
      return this.respond(response, outcome, { error: outcome }, { bookingNo });
    }

    const sub = String(payload.sub);
    const tid = String(payload.tid);
    const scope = String(payload.scope);
    const seen = { sub, tid, scope, bookingNo };

    const actor = payload.act;
    const delegatedByAssistant = typeof actor === "object" && actor !== null && (actor as { sub?: unknown }).sub === ASSISTANT_CLIENT_ID;
    if (!delegatedByAssistant) return this.respond(response, "delegation_required", { error: "delegation_required" }, seen);
    if (!scope.split(" ").includes(SCOPE_WRITE)) return this.respond(response, "insufficient_scope", { error: "insufficient_scope" }, seen);

    const body = await readJson(request);
    const { newStatus, expectedStatus } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof newStatus !== "string" || typeof expectedStatus !== "string") {
      return this.respond(response, "bad_request", { error: "bad_request" }, seen);
    }

    const booking = this.options.store.downstreamFind(tid, bookingNo);
    if (!booking || booking.ownerSubject !== sub) return this.respond(response, "not_found", { error: "not_found" }, seen);
    if (booking.status !== expectedStatus) return this.respond(response, "conflict", { error: "conflict" }, seen);

    const change = this.options.store.downstreamSetStatus(tid, bookingNo, newStatus, sub);
    this.respond(response, "applied", { bookingNo, previousStatus: change.from, newStatus: change.to }, seen);
  }
}
