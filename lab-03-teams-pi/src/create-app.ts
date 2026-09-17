import { randomUUID } from "node:crypto";

import { App } from "@microsoft/teams.apps";

import type { AgentRunner } from "./agent-runner.js";
import { deriveReply } from "./message-handler.js";
import { createTeamsTraceLogger, type TraceWriter } from "./teams-trace-logger.js";

const defaultWriter: TraceWriter = (line) => console.log(line);

/**
 * The Teams handler stays thin by design: extract input, delegate to the
 * AgentRunner, deliver the reply. It does not know whether the answer came
 * from a successful tool call, a bounded "not found" case, or a caught
 * provider failure inside the runner.
 */
export function createBookingApp(runner: AgentRunner, write: TraceWriter = defaultWriter): App {
  const app = new App({
    dangerouslyAllowUnauthenticatedRequests: true,
  });

  const trace = createTeamsTraceLogger(write);

  app.on("message", async (ctx) => {
    const conversationId = ctx.ref.conversation.id;
    const requestId = randomUUID();

    const answer = await deriveReply(runner, trace, {
      activityType: ctx.activity.type,
      conversationId,
      text: ctx.activity.text,
      requestId,
    });

    try {
      await ctx.reply(answer);
      trace({ type: "reply_sent", conversationId, requestId, text: answer });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace({ type: "handler_error", conversationId, requestId, error: message });
      throw error;
    }
  });

  return app;
}
