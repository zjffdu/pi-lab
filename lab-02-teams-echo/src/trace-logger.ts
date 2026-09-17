export type TeamsTraceEvent =
  | { type: "activity_received"; activityType: string; conversationId: string; text?: string }
  | { type: "reply_sent"; conversationId: string; text: string }
  | { type: "handler_error"; conversationId: string; error: string };

export type TraceWriter = (line: string) => void;

export function createTraceLogger(write: TraceWriter): (event: TeamsTraceEvent) => void {
  return (event) => {
    switch (event.type) {
      case "activity_received": {
        const textPart = event.text !== undefined ? ` text=${JSON.stringify(event.text)}` : "";
        write(`[Teams] activity_received type=${event.activityType} conversation=${event.conversationId}${textPart}`);
        break;
      }
      case "reply_sent":
        write(`[Teams] reply_sent conversation=${event.conversationId} text=${JSON.stringify(event.text)}`);
        break;
      case "handler_error":
        write(`[Teams] handler_error conversation=${event.conversationId} error=${event.error}`);
        break;
    }
  };
}
