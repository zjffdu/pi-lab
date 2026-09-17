export type TeamsTraceEvent =
  | { type: "activity_received"; activityType: string; conversationId: string; requestId: string; text?: string }
  | { type: "reply_sent"; conversationId: string; requestId: string; text: string }
  | { type: "handler_error"; conversationId: string; requestId: string; error: string };

export type TraceWriter = (line: string) => void;

/**
 * Same event shape as Lab 02's trace-logger, with the request ID that
 * correlates this line to the matching [Pi][req:...] lines from agent-runner.
 */
export function createTeamsTraceLogger(write: TraceWriter): (event: TeamsTraceEvent) => void {
  return (event) => {
    const prefix = `[Teams][req:${event.requestId}]`;

    switch (event.type) {
      case "activity_received": {
        const textPart = event.text !== undefined ? ` text=${JSON.stringify(event.text)}` : "";
        write(`${prefix} activity_received type=${event.activityType} conversation=${event.conversationId}${textPart}`);
        break;
      }
      case "reply_sent":
        write(`${prefix} reply_sent conversation=${event.conversationId} text=${JSON.stringify(event.text)}`);
        break;
      case "handler_error":
        write(`${prefix} handler_error conversation=${event.conversationId} error=${event.error}`);
        break;
    }
  };
}
