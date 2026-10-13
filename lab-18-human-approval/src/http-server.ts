import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import type { ActionService, DenialCode, StepResult, ActionView } from "./action-service.js";
import { ACTION_STATES, type ActionState } from "./action-state.js";
import type { Authenticate, AuthFailureReason } from "./authenticator.js";
import { ChatRunError, type ChatService } from "./chat-service.js";
import { SessionNotFoundError } from "./session-access.js";
import type { SecurityContext } from "./security-context.js";

const MAX_BODY_BYTES = 16 * 1024;

export interface HttpServerOptions {
  authenticate: Authenticate;
  chat: ChatService;
  actions: ActionService;
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
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequestError("body is not valid JSON");
  }
}

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequestError("body must be an object");
  return body as Record<string, unknown>;
}

function parseChatBody(body: unknown): { message: string; sessionId?: string } {
  const { message, sessionId } = objectBody(body);
  if (typeof message !== "string" || message.trim() === "") throw new BadRequestError("message must be a non-empty string");
  if (sessionId !== undefined && typeof sessionId !== "string") throw new BadRequestError("sessionId must be a string");
  return sessionId === undefined ? { message } : { message, sessionId };
}

const STATUS_FOR: Record<DenialCode, number> = {
  not_found: 404,
  forbidden: 403,
  self_approval: 403,
  invalid_state: 409,
  expired: 409,
  digest_mismatch: 409,
  stale_resource: 409,
  approver_no_longer_authorized: 403,
  requester_no_longer_authorized: 403,
  no_change: 409,
};

function respondStep(response: ServerResponse, requestId: string, result: StepResult<ActionView>): void {
  if (result.ok) {
    send(response, 200, { requestId, action: result.value });
    return;
  }
  send(response, STATUS_FOR[result.code], { error: result.code, ...(result.state === undefined ? {} : { state: result.state }), requestId });
}

type Route = { method: "GET" | "POST"; pattern: RegExp; run: (security: SecurityContext, match: RegExpExecArray, request: IncomingMessage, response: ServerResponse, requestId: string) => Promise<void> };

/**
 * A thin adapter. Authentication runs first, before a body is read, a session is opened, or a
 * database row is touched; the `SecurityContext` it produces is the only identity anything
 * downstream sees. Approval, rejection, revocation, and execution are endpoints a person's token
 * reaches — the model has no tool that reaches them.
 */
export function createHttpServer(options: HttpServerOptions): Server {
  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/v1\/chat$/,
      async run(security, _match, request, response) {
        const body = parseChatBody(await readJsonBody(request));
        send(response, 200, await options.chat.chat(security, body, BACKGROUND_CONTEXT));
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/actions$/,
      async run(security, _match, request, response, requestId) {
        const state = new URL(request.url ?? "/", "http://localhost").searchParams.get("state");
        if (state !== null && !(ACTION_STATES as readonly string[]).includes(state)) throw new BadRequestError("unknown state");
        const actions = await options.actions.list(security, state === null ? {} : { state: state as ActionState });
        send(response, 200, { requestId, actions });
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/actions\/([^/]+)$/,
      async run(security, match, _request, response, requestId) {
        const found = await options.actions.get(security, decodeURIComponent(match[1] ?? ""));
        if (!found) send(response, 404, { error: "not_found", requestId });
        else send(response, 200, { requestId, ...found });
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/actions\/([^/]+)\/approve$/,
      async run(security, match, request, response, requestId) {
        const { digest } = objectBody(await readJsonBody(request));
        if (typeof digest !== "string" || digest === "") throw new BadRequestError("digest must be the digest of the action being approved");
        respondStep(response, requestId, await options.actions.approve(security, decodeURIComponent(match[1] ?? ""), { digest }));
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/actions\/([^/]+)\/reject$/,
      async run(security, match, _request, response, requestId) {
        respondStep(response, requestId, await options.actions.reject(security, decodeURIComponent(match[1] ?? "")));
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/actions\/([^/]+)\/revoke$/,
      async run(security, match, _request, response, requestId) {
        respondStep(response, requestId, await options.actions.revoke(security, decodeURIComponent(match[1] ?? "")));
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/actions\/([^/]+)\/execute$/,
      async run(security, match, _request, response, requestId) {
        respondStep(response, requestId, await options.actions.execute(security, decodeURIComponent(match[1] ?? "")));
      },
    },
  ];

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) send(response, 500, { error: "internal_error" });
      else response.end();
      options.onRunFailure?.(error instanceof Error ? error.message : String(error), "unknown");
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    let matched: { route: Route; match: RegExpExecArray } | undefined;
    for (const route of routes) {
      const match = route.pattern.exec(pathname);
      if (match && route.method === request.method) {
        matched = { route, match };
        break;
      }
    }
    if (!matched) {
      send(response, 404, { error: "not_found", requestId });
      return;
    }

    const auth = await options.authenticate({ authorization: request.headers.authorization }, requestId);
    if (!auth.ok) {
      options.onAuthFailure?.(auth.reason, requestId);
      send(response, 401, { error: "unauthenticated", requestId });
      return;
    }

    try {
      await matched.route.run(auth.context, matched.match, request, response, requestId);
    } catch (error) {
      if (error instanceof SessionNotFoundError) send(response, 404, { error: "session_not_found", requestId });
      else if (error instanceof BadRequestError) send(response, 400, { error: "bad_request", requestId });
      else if (error instanceof ChatRunError) {
        options.onRunFailure?.(error.detail, requestId);
        send(response, 502, { error: error.code, requestId });
      } else {
        options.onRunFailure?.(error instanceof Error ? error.message : String(error), requestId);
        send(response, 500, { error: "internal_error", requestId });
      }
    }
  }
}
