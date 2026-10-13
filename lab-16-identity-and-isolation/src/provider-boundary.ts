import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";

/** What one provider request looked like, without any text from it. */
export interface RequestSummary {
  /** 1-based, per boundary instance. */
  index: number;
  messageCount: number;
  roles: string[];
}

export interface ProviderBoundaryViolation {
  request: number;
  messageIndex: number;
  role: string;
  /** Index into the forbidden list, not the forbidden text: a violation record is safe to log. */
  forbiddenIndex: number;
}

export interface ProviderBoundary {
  /** Install this in the registry. It selects itself into every conversation that follows the host default. */
  extension: Extension;
  /** Adds texts that must never appear in a request. Safe to call between requests; empty strings are ignored. */
  forbid(...texts: string[]): void;
  readonly forbiddenCount: number;
  readonly requests: readonly RequestSummary[];
  readonly violations: readonly ProviderBoundaryViolation[];
}

export interface ProviderBoundaryOptions {
  /** Called once per request with counts and roles only. */
  onRequest?: (summary: RequestSummary) => void;
}

function plainText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "thinking":
          return block.thinking;
        case "toolCall":
          return JSON.stringify(block.arguments);
        default:
          return "";
      }
    })
    .join("\n");
}

/**
 * The text a forbidden string is looked for in. `JSON.stringify` covers every field of the message,
 * including a system message's sections and a tool call's arguments; the plain text is searched as well
 * because `JSON.stringify` escapes quotes and newlines, so a forbidden string containing either would
 * never match its own serialized form.
 */
function searchableText(message: Message): string {
  return `${JSON.stringify(message)}\n${plainText(message)}`;
}

/**
 * Pi 0.85.1 had one hook at the very end of request building, `toProviderMessages`, which this lab wrapped.
 * Pi 1.1 has no such option. The closest point is the generation task's `beforeRequest` hook: it sees the
 * final `Message[]` of every request attempt, including a retry after a crash, and its result applies to
 * that request only.
 *
 * This is a CHECK, never a corrector: it returns `undefined`, so the request goes out exactly as built. If
 * a forbidden text is found, the bug is in whatever put it into context, and the violation is recorded,
 * not hidden. It does not block the request either: a hook that throws is reported and the next handler
 * runs, so it cannot be relied on to stop a request. `beforeRequest` is a generation hook, so it does not
 * cover the model requests a compaction makes.
 */
export function createProviderBoundary(options: ProviderBoundaryOptions = {}): ProviderBoundary {
  const forbidden: string[] = [];
  const requests: RequestSummary[] = [];
  const violations: ProviderBoundaryViolation[] = [];

  const extension = defineExtension({
    name: "provider-boundary",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request) => {
          const summary: RequestSummary = {
            index: requests.length + 1,
            messageCount: request.messages.length,
            roles: request.messages.map((message) => message.role),
          };
          requests.push(summary);

          request.messages.forEach((message, messageIndex) => {
            const text = searchableText(message);
            forbidden.forEach((forbiddenText, forbiddenIndex) => {
              if (text.includes(forbiddenText)) {
                violations.push({ request: summary.index, messageIndex, role: message.role, forbiddenIndex });
              }
            });
          });

          options.onRequest?.(summary);
          return undefined;
        },
      }),
    ],
  });

  return {
    extension,
    forbid(...texts) {
      for (const text of texts) {
        if (text !== "" && !forbidden.includes(text)) {
          forbidden.push(text);
        }
      }
    },
    get forbiddenCount() {
      return forbidden.length;
    },
    requests,
    violations,
  };
}
