import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the booking service, with scripted faults. It is deliberately a *real* HTTP
 * server (so timeouts, aborts, and `Retry-After` go through real sockets) that also keeps its own
 * account of what it saw, so a test can compare the connector's view of a call with the server's:
 * how many requests arrived, which were abandoned by the client, and which kept working anyway.
 */
export type Route = "booking" | "containers";

export type Fault =
  | { kind: "status"; status: number; retryAfter?: string }
  | { kind: "hang" }
  /** Answers normally after `ms`. The server keeps working if the client leaves in the meantime. */
  | { kind: "delay"; ms: number }
  | { kind: "malformed-json" }
  | { kind: "drop-field"; field: string }
  | { kind: "wrong-type"; field: string; value: unknown }
  | { kind: "bad-timestamp"; field: string; value: string }
  | { kind: "wrong-booking" }
  /** Reports `nextCursor` equal to the cursor it was just given. */
  | { kind: "repeat-cursor" }
  /** Never returns a null `nextCursor`: every page points at another one. */
  | { kind: "endless-pages" }
  /**
   * Makes the booking record disagree with its own container listing: `extra` adds a container number the
   * listing never returns; `swap` replaces the last one with a foreign number, so the *count* still matches.
   */
  | { kind: "container-mismatch"; mode: "extra" | "swap" }
  /** Replaces the first container of the page with one that is not the booking's (`FOREIGN0001`, 99999 kg). */
  | { kind: "foreign-container" }
  /** Serves the first page's containers again on whatever page is asked for (cursors still advance). */
  | { kind: "replay-first-page" }
  /** Answers 200 with a chunked (no Content-Length) body of `bytes` bytes of valid-looking JSON padding. */
  | { kind: "oversize-body"; bytes: number };

export interface FaultMatch {
  route?: Route;
  tenant?: string;
  bookingNo?: string;
  /** 1-based page of a containers listing. */
  page?: number;
}

export interface RequestLogEntry {
  seq: number;
  route: Route | "unknown";
  tenant: string;
  bookingNo: string;
  page: number;
  requestId: string | undefined;
  toolCallId: string | undefined;
  opId: string | undefined;
  attempt: number | undefined;
  /** HTTP status written, or `undefined` if the client left before a response was written. */
  status: number | undefined;
  /** The client closed the connection before the response finished. */
  clientAborted: boolean;
  /** The handler ran to the end of its work (relevant to `delay`: abort does not undo server-side work). */
  workCompleted: boolean;
  /** Bytes of a chunked `oversize-body` response actually written before the client left. */
  bytesWritten: number;
}

interface BookingData {
  bookingNo: string;
  status: string;
  documentCutoff: string;
  updatedAt: string;
  containers: { containerNo: string; weightKg: number }[];
}

export interface FakeApiOptions {
  clock?: () => Date;
  /** Token -> tenants it may read. */
  tokens?: Record<string, string[]>;
  data?: Record<string, BookingData[]>;
}

export const FULL_ACCESS_TOKEN = "svc-lab20-full";
export const TENANT_A_ONLY_TOKEN = "svc-lab20-tenant-a";
const DEFAULT_TOKENS: Record<string, string[]> = { [FULL_ACCESS_TOKEN]: ["tenant-a", "tenant-b"], [TENANT_A_ONLY_TOKEN]: ["tenant-a"] };
const MAX_LIMIT = 50;

function loadDefaultData(): Record<string, BookingData[]> {
  const parsed = JSON.parse(readFileSync(new URL("../../data/bookings.json", import.meta.url), "utf8")) as { tenants: Record<string, BookingData[]> };
  return parsed.tenants;
}

interface ScheduledFault {
  match: FaultMatch;
  fault: Fault;
  remaining: number;
}

function deleteAt(target: unknown, path: string[]): void {
  const [head, ...rest] = path;
  if (typeof target !== "object" || target === null || head === undefined) return;
  const record = target as Record<string, unknown>;
  if (rest.length === 0) delete record[head];
  else deleteAt(record[head], rest);
}

function setAt(target: unknown, path: string[], value: unknown): void {
  const [head, ...rest] = path;
  if (typeof target !== "object" || target === null || head === undefined) return;
  const record = target as Record<string, unknown>;
  if (rest.length === 0) record[head] = value;
  else setAt(record[head], rest, value);
}

export class FakeBookingApi {
  public readonly log: RequestLogEntry[] = [];
  /** Handlers that finished their work, including ones whose client had already left. */
  public workCompleted = 0;
  private readonly faults: ScheduledFault[] = [];
  private readonly clock: () => Date;
  private readonly tokens: Record<string, string[]>;
  private readonly data: Record<string, BookingData[]>;
  private server: Server | undefined;
  private seq = 0;

  public constructor(options: FakeApiOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.tokens = options.tokens ?? DEFAULT_TOKENS;
    this.data = options.data ?? loadDefaultData();
  }

  public async start(port = 0): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server?.listen(port, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  public async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Schedules `fault` for the next `times` matching requests (default 1). */
  public inject(fault: Fault, match: FaultMatch = {}, times = 1): this {
    this.faults.push({ match, fault, remaining: times });
    return this;
  }

  public clearFaults(): void {
    this.faults.length = 0;
  }

  public requestsFor(route: Route): RequestLogEntry[] {
    return this.log.filter((entry) => entry.route === route);
  }

  private takeFault(route: Route, tenant: string, bookingNo: string, page: number): Fault | undefined {
    for (const scheduled of this.faults) {
      if (scheduled.remaining <= 0) continue;
      const { match } = scheduled;
      if (match.route !== undefined && match.route !== route) continue;
      if (match.tenant !== undefined && match.tenant !== tenant) continue;
      if (match.bookingNo !== undefined && match.bookingNo !== bookingNo) continue;
      if (match.page !== undefined && match.page !== page) continue;
      scheduled.remaining -= 1;
      return scheduled.fault;
    }
    return undefined;
  }

  private write(response: ServerResponse, entry: RequestLogEntry, status: number, body: string, headers: Record<string, string> = {}): void {
    if (response.destroyed || response.writableEnded) return;
    entry.status = status;
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
    response.end(body);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = /^\/v1\/tenants\/([^/]+)\/bookings\/([^/]+)(\/containers)?$/.exec(url.pathname);
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const tenant = match?.[1] ? decodeURIComponent(match[1]) : "";
    const bookingNo = match?.[2] ? decodeURIComponent(match[2]) : "";
    const route: Route | "unknown" = match === null ? "unknown" : match[3] ? "containers" : "booking";
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? "10") || 10));
    const cursor = url.searchParams.get("cursor");
    const offset = cursor?.startsWith("c") ? Number(cursor.slice(1)) : 0;
    const page = Math.floor(offset / limit) + 1;

    const entry: RequestLogEntry = {
      seq: ++this.seq,
      route,
      tenant,
      bookingNo,
      page,
      requestId: header("x-request-id"),
      toolCallId: header("x-tool-call-id"),
      opId: header("x-op-id"),
      attempt: header("x-attempt") === undefined ? undefined : Number(header("x-attempt")),
      status: undefined,
      clientAborted: false,
      workCompleted: false,
      bytesWritten: 0,
    };
    this.log.push(entry);
    response.on("close", () => {
      if (!response.writableFinished) entry.clientAborted = true;
    });

    if (route === "unknown") return this.write(response, entry, 404, JSON.stringify({ error: "no_such_route" }));

    const token = header("authorization")?.replace(/^Bearer /, "");
    const scope = token === undefined ? undefined : this.tokens[token];
    if (scope === undefined) return this.write(response, entry, 401, JSON.stringify({ error: "unauthenticated" }));
    if (!scope.includes(tenant)) return this.write(response, entry, 403, JSON.stringify({ error: "forbidden" }));

    const fault = this.takeFault(route, tenant, bookingNo, page);
    if (fault?.kind === "status") {
      const headers: Record<string, string> = fault.retryAfter === undefined ? {} : { "retry-after": fault.retryAfter };
      return this.write(response, entry, fault.status, JSON.stringify({ error: `fault_${fault.status}` }), headers);
    }
    if (fault?.kind === "hang") return; // never answers; ends when the client leaves
    if (fault?.kind === "delay") {
      await new Promise((resolve) => setTimeout(resolve, fault.ms));
      // The work is done whether or not anyone is still listening: an abort does not un-do it.
      entry.workCompleted = true;
      this.workCompleted += 1;
    } else {
      entry.workCompleted = true;
      this.workCompleted += 1;
    }
    if (fault?.kind === "oversize-body") {
      entry.status = 200;
      response.writeHead(200, { "content-type": "application/json" }); // no content-length: chunked
      response.write('{"data":{"pad":"');
      const chunk = "x".repeat(1024);
      for (let sent = 0; sent < fault.bytes && !response.destroyed; sent += chunk.length) {
        response.write(chunk);
        entry.bytesWritten += chunk.length;
        await new Promise((resolve) => setImmediate(resolve)); // let a client hang-up be noticed between chunks
      }
      response.end('"}}');
      return;
    }
    if (fault?.kind === "malformed-json") return this.write(response, entry, 200, '{"data": {"bookingNo": ');

    const booking = this.data[tenant]?.find((candidate) => candidate.bookingNo === bookingNo);
    if (!booking) return this.write(response, entry, 404, JSON.stringify({ error: "not_found" }));

    const asOf = this.clock().toISOString();
    let body: Record<string, unknown>;
    if (route === "booking") {
      const claimed = booking.containers.map((container) => container.containerNo);
      if (fault?.kind === "container-mismatch") {
        if (fault.mode === "extra") claimed.push("GHOST0000001");
        else claimed[claimed.length - 1] = "GHOST0000001";
      }
      body = {
        data: {
          bookingNo: fault?.kind === "wrong-booking" ? "BK0000" : booking.bookingNo,
          status: booking.status,
          documentCutoff: booking.documentCutoff,
          updatedAt: booking.updatedAt,
          containerNos: claimed,
          internalNote: "not part of the contract; must never be passed on",
        },
        asOf,
      };
    } else {
      const itemOffset = fault?.kind === "replay-first-page" ? 0 : offset;
      const items = booking.containers.slice(itemOffset, itemOffset + limit);
      if (fault?.kind === "foreign-container" && items.length > 0) items[0] = { containerNo: "FOREIGN0001", weightKg: 99_999 };
      const endless = fault?.kind === "endless-pages";
      const filler = endless && items.length < limit ? Array.from({ length: limit - items.length }, (_unused, index) => ({ containerNo: `FILL${offset + items.length + index}`, weightKg: 1 })) : [];
      const next = offset + limit < booking.containers.length || endless ? `c${offset + limit}` : null;
      body = { data: { items: [...items, ...filler], nextCursor: fault?.kind === "repeat-cursor" && cursor !== null ? cursor : next }, asOf };
    }

    if (fault?.kind === "drop-field") deleteAt(body, fault.field.split("."));
    if (fault?.kind === "wrong-type" || fault?.kind === "bad-timestamp") setAt(body, fault.field.split("."), fault.value);
    this.write(response, entry, 200, JSON.stringify(body));
  }
}
