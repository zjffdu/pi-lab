import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import type { Authenticate, AuthFailureReason } from "./authenticator.js";
import { ChatRunError, type ChatService } from "./chat-service.js";
import { SessionNotFoundError } from "./session-access.js";

const MAX_BODY_BYTES = 16 * 1024;

export interface HttpServerOptions {
  authenticate: Authenticate;
  chat: ChatService;
  /** Server-side only: the reason never reaches the client. Never receives the token. */
  onAuthFailure?: (reason: AuthFailureReason, requestId: string) => void;
  /** Server-side only: internal detail for a failed run. */
  onRunFailure?: (detail: string, requestId: string) => void;
}

class BadRequestError extends Error {}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
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
 * A deliberately thin adapter: authenticate, then hand a `SecurityContext` to `ChatService`.
 *
 * - The request ID is generated here; any `X-Request-Id` a client sends is ignored.
 * - Authentication runs first, before the body is read, a session is looked up, or a harness
 *   exists, so a rejected request costs no session read and no model call.
 * - Only `Authorization` is consulted for identity. `X-Tenant-Id`, `X-User-Id`, and the like are
 *   never read, so a forged one has nothing to influence.
 * - Every authentication failure gets the same 401 body, and an unknown session gets the same
 *   404 body as someone else's.
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
    const historyMatch = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    const compactMatch = /^\/v1\/sessions\/([^/]+)\/compact$/.exec(url.pathname);
    const isChat = request.method === "POST" && url.pathname === "/v1/chat";
    const isHistory = request.method === "GET" && historyMatch !== null;
    const isCompact = request.method === "POST" && compactMatch !== null;
    if (!isChat && !isHistory && !isCompact) {
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

    try {
      if (isCompact && compactMatch?.[1]) {
        const result = await options.chat.compact(security, decodeURIComponent(compactMatch[1]), BACKGROUND_CONTEXT);
        send(response, 200, { requestId, ...result });
        return;
      }
      if (isHistory && historyMatch?.[1]) {
        const messages = await options.chat.history(security, decodeURIComponent(historyMatch[1]), BACKGROUND_CONTEXT);
        send(response, 200, { requestId, messages });
        return;
      }
      const body = parseChatBody(await readJsonBody(request));
      const result = await options.chat.chat(security, body, BACKGROUND_CONTEXT);
      send(response, 200, result);
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        send(response, 404, { error: "session_not_found", requestId });
      } else if (error instanceof BadRequestError) {
        send(response, 400, { error: "bad_request", requestId });
      } else if (error instanceof ChatRunError) {
        options.onRunFailure?.(error.detail, requestId);
        // `context_unsafe` is a conflict with current access, not a server fault; the client's fix is a new session.
        send(response, error.code === "context_unsafe" ? 409 : 502, { error: error.code, requestId });
      } else {
        options.onRunFailure?.(error instanceof Error ? error.message : String(error), requestId);
        send(response, 500, { error: "internal_error", requestId });
      }
    }
  }
}
