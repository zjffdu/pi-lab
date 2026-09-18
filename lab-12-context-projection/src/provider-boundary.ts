import { convertToLlm, type AgentMessage, type Context } from "@earendil-works/pi-agent-core";
import type { Message, TextContent } from "@earendil-works/pi-ai";

export interface ProviderBoundaryViolation {
  messageIndex: number;
  matchedText: string;
}

function isTextContent(block: { type: string }): block is TextContent {
  return block.type === "text";
}

function extractProviderMessageText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter(isTextContent)
    .map((block) => block.text)
    .join(" ");
}

/**
 * Wraps the harness's own default `AgentMessage[] -> Message[]` conversion (`convertToLlm`)
 * with one explicit check at the literal last point, inside Pi, before a request payload
 * leaves this process for the model provider — the `toProviderMessages` option in
 * `AgentHarnessOptions`. This function is a *check*, not a corrector: it never edits or drops
 * anything from what `convertToLlm` produced. If sanitization has a bug, this makes that bug
 * loud (via `onViolation`) instead of silently papering over it — the bug belongs in
 * `entry-projectors.ts`, not here.
 *
 * `onViolation` fires once per (message, forbidden substring) match, synchronously, before
 * this function returns — this lab's tests and demo use it to prove the negative
 * ("the internal-only field never reaches the provider") deterministically instead of only
 * eyeballing a transcript.
 */
export function createGuardedToProviderMessages(
  forbiddenSubstrings: readonly string[],
  onViolation: (violation: ProviderBoundaryViolation) => void,
): (messages: AgentMessage[], context: Context) => Message[] {
  return (messages: AgentMessage[], _context: Context): Message[] => {
    const providerMessages = convertToLlm(messages);

    providerMessages.forEach((message, messageIndex) => {
      const text = extractProviderMessageText(message);
      for (const forbidden of forbiddenSubstrings) {
        if (text.includes(forbidden)) {
          onViolation({ messageIndex, matchedText: forbidden });
        }
      }
    });

    return providerMessages;
  };
}
