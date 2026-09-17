import "dotenv/config";

import { createSessionAgent, modelSelectionFromEnvironment } from "./create-agent.js";
import { createSessionRegistry } from "./session-registry.js";
import { createSessionTraceLogger } from "./session-trace-logger.js";

interface ScenarioTurn {
  conversationId: string;
  message: string;
}

/**
 * The roadmap's live scenario: two messages in "conversation-a" (the second
 * one a follow-up that only makes sense with the first message's tool
 * result still in context), then the same follow-up alone in
 * "conversation-b" to show that a different conversation id cannot see it.
 */
const DEFAULT_SCENARIO: ScenarioTurn[] = [
  { conversationId: "conversation-a", message: "What are the details for booking BK1001?" },
  { conversationId: "conversation-a", message: "Which container is it using?" },
  { conversationId: "conversation-b", message: "Which container is it using?" },
];

function parseScenario(argv: string[]): ScenarioTurn[] {
  if (argv.length === 0) {
    return DEFAULT_SCENARIO;
  }

  const turns: ScenarioTurn[] = [];
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag !== "--conversation") {
      throw new Error(`Expected --conversation, got "${flag}"`);
    }

    const conversationId = argv[index + 1];
    const message = argv[index + 2];
    if (!conversationId || !message) {
      throw new Error("Each --conversation flag needs a conversation id and a message");
    }

    turns.push({ conversationId, message });
    index += 3;
  }

  return turns;
}

async function main(): Promise<void> {
  const turns = parseScenario(process.argv.slice(2));
  const selection = modelSelectionFromEnvironment();
  const registry = createSessionRegistry(() => createSessionAgent(selection));

  console.log(`[Setup] model=${selection.provider}/${selection.modelId}`);

  for (const turn of turns) {
    const isNewConversation = !registry.has(turn.conversationId);
    const agent = registry.getOrCreate(turn.conversationId);

    if (isNewConversation) {
      agent.subscribe(createSessionTraceLogger(turn.conversationId, (line) => console.log(line)));
    }

    console.log(
      `[Session] conversation=${turn.conversationId} ${isNewConversation ? "created" : "reused"} registry_size=${registry.size()}`,
    );
    console.log(`[User][${turn.conversationId}] ${turn.message}`);

    await agent.prompt(turn.message);

    if (agent.state.errorMessage) {
      throw new Error(
        `Agent run failed for conversation ${turn.conversationId}: ${agent.state.errorMessage}`,
      );
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Fatal] ${message}`);
  process.exitCode = 1;
});
