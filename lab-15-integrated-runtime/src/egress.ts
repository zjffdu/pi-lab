import type { Context } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import {
  type Conversation,
  defineExtension,
  type Extension,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";

/**
 * A value that must never leave the process toward a model provider. `label` is what reports and errors may
 * say; `value` is only ever compared against, never printed.
 */
export interface ForbiddenValue {
  label: string;
  value: string;
}

export class EgressViolationError extends Error {
  public constructor(public readonly labels: readonly string[]) {
    super(`Egress blocked: content contains prohibited values (${labels.join(", ")}).`);
    this.name = "EgressViolationError";
  }
}

/** JSON-escaped form of a value, so a value containing a quote or newline is still found inside serialized JSON. */
function escaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Labels of forbidden values found anywhere in these messages. Pi 1.1 puts the system prompt and the tool
 * declarations *inside* the request's leading `system` message, so — unlike Pi 0.85.1, where they were
 * separate request fields no hook saw — they are scanned too. Matching is verbatim, never a paraphrase.
 */
export function findViolations(messages: readonly Message[], forbidden: readonly ForbiddenValue[]): string[] {
  const serialized = JSON.stringify(messages);
  return forbidden.filter((item) => serialized.includes(item.value) || serialized.includes(escaped(item.value))).map((item) => item.label);
}

export const WITHHELD = "[withheld by egress guard]";

/** The same message with every forbidden value replaced. Structure, roles, and tool-call pairing are kept. */
function withhold(message: Message, forbidden: readonly ForbiddenValue[]): Message {
  let text = JSON.stringify(message);
  for (const item of forbidden) {
    text = text.split(escaped(item.value)).join(WITHHELD).split(item.value).join(WITHHELD);
  }
  return JSON.parse(text) as Message;
}

/**
 * Layer 1 — per-request preflight, run before the prompt is submitted. Pi 1.1 exposes the conversation's
 * committed model context (`Conversation.context()`), so this reads what Pi itself would send rather than
 * rebuilding it, then adds the prompt that has not been committed yet. A violation refuses only this
 * request: nothing is submitted and the harness stays healthy.
 *
 * It does not see the leading `system` message: that entry is written when the run starts. The backstop does.
 */
export async function preflightEgress(
  conversation: Conversation,
  forbidden: readonly ForbiddenValue[],
  prompt: string,
  context: Context,
): Promise<string[]> {
  const committed = (await conversation.context(context)).messages;
  return findViolations([...committed, { role: "user", content: prompt, timestamp: Date.now() }], forbidden);
}

/** A forbidden value the backstop found in one request, by label only. */
export interface BackstopViolation {
  /** 1-based, per backstop instance. */
  request: number;
  messageIndex: number;
  role: string;
  labels: string[];
}

export interface EgressBackstop {
  extension: Extension;
  readonly requests: number;
  readonly violations: readonly BackstopViolation[];
}

/**
 * Layer 2 — the backstop, a generation `beforeRequest` hook. It sees the final `Message[]` of every request
 * attempt, and its result replaces the messages for that request only.
 *
 * What it can NOT do is stop the request. A throw from this hook is reported (`onReport`) and the request is
 * sent anyway — verified, not read from the types — so this hook *withholds* instead: it replaces each
 * forbidden value in the request with `WITHHELD`, leaves storage untouched, and records the violation. The
 * provider still gets a request; it just does not get the value. Reaching this layer means an upstream layer
 * failed, so a recorded violation is a mechanism failure for that request (`verifyMechanism`).
 *
 * It does not cover a compaction's own model requests (that is a different task).
 */
export function createEgressBackstop(forbidden: readonly ForbiddenValue[]): EgressBackstop {
  const violations: BackstopViolation[] = [];
  let requests = 0;

  const extension = defineExtension({
    name: "egress-backstop",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request) => {
          requests += 1;
          let changed = false;
          const messages = request.messages.map((message, messageIndex) => {
            const labels = findViolations([message], forbidden);
            if (labels.length === 0) return message;
            changed = true;
            violations.push({ request: requests, messageIndex, role: message.role, labels });
            return withhold(message, forbidden);
          });
          return changed ? { messages } : undefined;
        },
      }),
    ],
  });

  return {
    extension,
    get requests() {
      return requests;
    },
    violations,
  };
}
