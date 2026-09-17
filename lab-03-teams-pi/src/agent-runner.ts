import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createBookingAgent, modelSelectionFromEnvironment, type ModelSelection } from "./create-agent.js";
import { createPiTraceLogger, type TraceWriter } from "./pi-trace-logger.js";

export interface AgentRunInput {
  text: string;
  requestId: string;
}

export interface AgentRunResult {
  answer: string;
}

/**
 * The boundary between the thin Teams handler and the Pi agent loop.
 *
 * `run` never rejects. A provider or setup failure is caught here and turned
 * into a bounded infrastructure answer, so the Teams transport stays alive
 * for the next message regardless of what happened inside Pi.
 */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export const INFRASTRUCTURE_ERROR_ANSWER =
  "Sorry, I could not reach the assistant service for this request. Please try again in a moment.";

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestAssistantText(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    if (text) {
      return text;
    }
  }

  return undefined;
}

export function createPiAgentRunner(
  selection: ModelSelection = modelSelectionFromEnvironment(),
  write: TraceWriter = (line) => console.log(line),
): AgentRunner {
  return {
    async run({ text, requestId }) {
      let agent;
      try {
        agent = createBookingAgent(selection);
      } catch (error) {
        write(`[Pi][req:${requestId}] setup_error ${errorMessageOf(error)}`);
        return { answer: INFRASTRUCTURE_ERROR_ANSWER };
      }

      agent.subscribe(createPiTraceLogger(requestId, write));

      try {
        await agent.prompt(text);
      } catch (error) {
        write(`[Pi][req:${requestId}] prompt_error ${errorMessageOf(error)}`);
        return { answer: INFRASTRUCTURE_ERROR_ANSWER };
      }

      if (agent.state.errorMessage) {
        write(`[Pi][req:${requestId}] provider_error ${agent.state.errorMessage}`);
        return { answer: INFRASTRUCTURE_ERROR_ANSWER };
      }

      const answer = latestAssistantText(agent.state.messages);
      if (!answer) {
        write(`[Pi][req:${requestId}] empty_answer`);
        return { answer: INFRASTRUCTURE_ERROR_ANSWER };
      }

      return { answer };
    },
  };
}
