import { App } from "@microsoft/teams.apps";

import { formatEcho } from "./echo.js";
import { createTraceLogger, type TraceWriter } from "./trace-logger.js";

const defaultWriter: TraceWriter = (line) => console.log(line);

export function createEchoApp(write: TraceWriter = defaultWriter): App {
  const app = new App({
    dangerouslyAllowUnauthenticatedRequests: true,
  });

  const trace = createTraceLogger(write);

  app.on("message", async (ctx) => {
    const conversationId = ctx.ref.conversation.id;
    const text = ctx.activity.text;

    trace({ type: "activity_received", activityType: ctx.activity.type, conversationId, text });

    const reply = formatEcho(text);

    try {
      await ctx.reply(reply);
      trace({ type: "reply_sent", conversationId, text: reply });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace({ type: "handler_error", conversationId, error: message });
      throw error;
    }
  });

  return app;
}
