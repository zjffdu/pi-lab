import "dotenv/config";

import type { AgentEvent } from "@earendil-works/pi-agent-core";

import { createConcurrentMessagePolicy } from "./concurrent-message-policy.js";
import { createResilienceAgent, modelSelectionFromEnvironment } from "./create-agent.js";
import { createSessionRegistry } from "./session-registry.js";
import { createResilienceTraceLogger } from "./trace-logger.js";

type ExperimentId = "a" | "b" | "c" | "d";

interface ExperimentDefinition {
  conversationId: string;
  message: string;
  description: string;
}

const EXPERIMENTS: Record<ExperimentId, ExperimentDefinition> = {
  a: {
    conversationId: "experiment-a",
    message: "Look up booking BAD_ID and tell me which container it uses.",
    description: "Tool error: get_booking(BAD_ID) must fail into a bounded answer, not a fabricated one.",
  },
  b: {
    conversationId: "experiment-b",
    message: "Investigate booking BK1001 for departure delay and port congestion risk.",
    description:
      "Slow tool + steer(): a steering message sent while get_port_status is still running should " +
      "land only after the current turn's tool calls all finish.",
  },
  c: {
    conversationId: "experiment-c",
    message: "Investigate booking BK1001 for departure delay and port congestion risk.",
    description:
      "Slow tool + followUp(): a follow-up queued while get_port_status is still running should run " +
      "only after the agent would otherwise have stopped.",
  },
  d: {
    conversationId: "experiment-d",
    message: "Investigate booking BK1001 for departure delay and port congestion risk.",
    description:
      "Parallel tools: get_container_events and get_port_status share one turn; the [Timeline] block " +
      "should show transcript order matching source order even when end= timestamps differ.",
  },
};

function parseExperiment(argv: string[]): ExperimentId {
  const flagIndex = argv.indexOf("--experiment");
  const value = flagIndex >= 0 ? argv[flagIndex + 1] : argv[0];

  if (value === "a" || value === "b" || value === "c" || value === "d") {
    return value;
  }

  throw new Error(
    "Pass --experiment <a|b|c|d> (a=tool error, b=steer, c=follow-up, d=parallel tools)",
  );
}

function portStatusDelayMs(experiment: ExperimentId, environment: NodeJS.ProcessEnv): number {
  const raw = environment.LAB06_PORT_STATUS_DELAY_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return experiment === "b" || experiment === "c" ? 900 : 0;
}

async function main(): Promise<void> {
  const experiment = parseExperiment(process.argv.slice(2));
  const definition = EXPERIMENTS[experiment];
  const selection = modelSelectionFromEnvironment();
  const delayMs = portStatusDelayMs(experiment, process.env);

  const registry = createSessionRegistry(() =>
    createResilienceAgent(selection, { portStatusDelayMs: delayMs }),
  );
  const policy = createConcurrentMessagePolicy(registry);

  console.log(`[Setup] experiment=${experiment} model=${selection.provider}/${selection.modelId}`);
  console.log(`[Setup] ${definition.description}`);
  if (delayMs > 0) {
    console.log(`[Setup] get_port_status artificial delay = ${delayMs}ms`);
  }

  const agent = registry.getOrCreate(definition.conversationId);
  agent.subscribe(createResilienceTraceLogger(definition.conversationId, (line) => console.log(line)));

  if (experiment === "b" || experiment === "c") {
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type !== "tool_execution_start" || event.toolName !== "get_port_status") {
        return;
      }

      unsubscribe();

      if (experiment === "b") {
        console.log(
          `[Harness][${definition.conversationId}] steer() while get_port_status is still running`,
        );
        agent.steer({
          role: "user",
          content: "Also say whether the delay looks likely to get worse.",
          timestamp: Date.now(),
        });
      } else {
        console.log(
          `[Harness][${definition.conversationId}] followUp() while get_port_status is still running`,
        );
        agent.followUp({
          role: "user",
          content: "Also give me a one-sentence summary for a dashboard.",
          timestamp: Date.now(),
        });
      }
    });
  }

  console.log(`[User][${definition.conversationId}] ${definition.message}`);
  const { delivery, settled } = policy.sendMessage(definition.conversationId, definition.message);
  console.log(`[Harness][${definition.conversationId}] delivery=${delivery}`);
  await settled;

  if (agent.state.errorMessage) {
    throw new Error(`Agent run failed: ${agent.state.errorMessage}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
