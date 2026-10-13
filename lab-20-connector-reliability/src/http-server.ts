import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { OverloadedError, type AdmissionQueue } from "./admission-queue.js";
import type { Authenticate, AuthFailureReason } from "./authenticator.js";
import { ChatRunError, type ChatService } from "./chat-service.js";
import { SessionNotFoundError } from "./session-access.js";

const MAX_BODY_BYTES = 16 * 1024;

export type RunOutcome = "completed" | "incomplete" | "cancelled" | "failed" | "overloaded";

export interface HttpServerOptions {
  authenticate: Authenticate;
  chat: ChatService;
  queue: AdmissionQueue;
  /** Server-side only: the reason never reaches the client. Never receives the token. */
  onAuthFailure?: (reason: AuthFailureReason, requestId: string) => void;
  /** Server-side only: internal detail for a failed run. */
  onRunFailure?: (detail: string, requestId: string) => void;
  /** One call per authenticated chat request that reached the run stage (not for 400/404 rejections). */
  onRunOutcome?: (outcome: RunOutcome, requestId: string) => void;
}

class BadRequestError extends Error {}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new BadRequestError("body too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequestError("body is not valid JSON");
  }
}

function parseChatBody(body: unknown): { message: string; sessionId?: string } {
  if (typeof body !== "object" || body === null) throw new BadRequestError("body must be an object");
  const { message, sessionId } = body as Record<string, unknown>;
  if (typeof message !== "string" || message.trim() === "") throw new BadRequestError("message must be a non-empty string");
  if (sessionId !== undefined && typeof sessionId !== "string") throw new BadRequestError("sessionId must be a string");
  return sessionId === undefined ? { message } : { message, sessionId };
}

/**
 * A thin adapter: authenticate, take a slot in the admission queue, run.
 *
 * - Identity is checked first (before the body is read, a slot taken, or a session opened), so an
 *   unauthenticated request never occupies capacity.
 * - The queue is bounded. A full queue, or a wait longer than the limit, is an explicit `503` with
 *   `Retry-After` — the client is told to come back, not left hanging.
 * - If the client disconnects, `clientGone` aborts: a queued request leaves the line, a running one is
 *   cancelled through the chat service, and the abort reaches the booking API request in flight.
 */
export function createHttpServer(options: HttpServerOptions): Server {
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) send(response, 500, { error: "internal_error" });
      else response.end();
      options.onRunFailure?.(error instanceof Error ? error.message : String(error), "unknown");
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!(request.method === "POST" && url.pathname === "/v1/chat")) {
      send(response, 404, { error: "not_found", requestId });
      return;
    }

    const auth = await options.authenticate({ authorization: request.headers.authorization }, requestId);
    if (!auth.ok) {
      options.onAuthFailure?.(auth.reason, requestId);
      send(response, 401, { error: "unauthenticated", requestId });
      return;
    }
    const security = auth.context;

    const clientGone = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) clientGone.abort();
    });

    try {
      const body = parseChatBody(await readJsonBody(request));
      const result = await options.queue.run(() => options.chat.chat(security, body, { cancel: clientGone.signal }), clientGone.signal);
      options.onRunOutcome?.(result.status, requestId);
      send(response, 200, result);
    } catch (error) {
      if (clientGone.signal.aborted) {
        options.onRunOutcome?.("cancelled", requestId);
        return;
      }
      if (error instanceof OverloadedError) {
        options.onRunOutcome?.("overloaded", requestId);
        send(response, 503, { error: "overloaded", reason: error.reason, requestId }, { "retry-after": String(error.retryAfterSeconds) });
      } else if (error instanceof SessionNotFoundError) {
        send(response, 404, { error: "session_not_found", requestId });
      } else if (error instanceof BadRequestError) {
        send(response, 400, { error: "bad_request", requestId });
      } else if (error instanceof ChatRunError) {
        options.onRunOutcome?.(error.code === "cancelled" ? "cancelled" : "failed", requestId);
        options.onRunFailure?.(error.detail, requestId);
        send(response, 502, { error: error.code, requestId });
      } else {
        options.onRunOutcome?.("failed", requestId);
        options.onRunFailure?.(error instanceof Error ? error.message : String(error), requestId);
        send(response, 500, { error: "internal_error", requestId });
      }
    }
  }
}
