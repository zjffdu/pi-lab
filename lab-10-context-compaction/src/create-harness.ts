import {
  AgentHarness,
  type AgentLane,
  type CompactionSettings,
  type Context,
  type OpenOperation,
  type Session,
} from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { BookingRepository } from "./booking-repository.js";
import { ContainerEventRepository } from "./container-event-repository.js";
import { createGetBookingTool } from "./get-booking-tool.js";
import { createGetContainerEventsTool } from "./get-container-events-tool.js";

const SYSTEM_PROMPT = `You are a booking-operations assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a booking's route, vessel, dates, or hold
  status. Call get_container_events before making any claim about a container's movement
  history. Both are read-only.
- Use only facts returned by a tool, a compacted summary, or already established earlier in
  this same durable session. The session may span multiple turns and may have been compacted;
  treat anything in the transcript (including a "conversation history before this point was
  compacted into the following summary" block) as established fact, whether or not you
  personally produced it.
- If you are not sure whether an earlier fact survived compaction, say so plainly instead of
  guessing or inventing a value.
- Keep answers concise.`;

export interface ModelSelection {
  provider: string;
  modelId: string;
}

export function modelSelectionFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ModelSelection {
  return {
    provider: environment.PI_PROVIDER?.trim() || "deepseek",
    modelId: environment.PI_MODEL?.trim() || "deepseek-v4-flash",
  };
}

function positiveIntFromEnvironment(environment: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = environment[key]?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Deliberately tiny compared to `DEFAULT_COMPACTION_SETTINGS`
 * (`reserveTokens: 16384, keepRecentTokens: 20000`) so that this lab's seeded conversation —
 * a few thousand tokens at most — actually crosses a real cut point instead of being entirely
 * "recent" and left untouched. `reserveTokens` doubles as the summary's own output token
 * budget (`compact()` caps it at `0.8 * reserveTokens`); kept modest on purpose so the summary
 * itself cannot approach the size of what it is replacing (see README section 5's measured
 * finding about summary overhead on a *short* conversation).
 */
export function compactionSettingsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): CompactionSettings {
  return {
    enabled: true,
    reserveTokens: positiveIntFromEnvironment(environment, "COMPACT_RESERVE_TOKENS", 300),
    keepRecentTokens: positiveIntFromEnvironment(environment, "COMPACT_KEEP_RECENT_TOKENS", 180),
  };
}

export interface OpenMainLaneResult {
  harness: AgentHarness;
  lane: AgentLane;
  /** Lanes with a durable operation left open when the harness attached to this session. */
  open: OpenOperation[];
}

export interface OpenMainLaneOptions {
  selection?: ModelSelection;
  compaction?: CompactionSettings;
}

/**
 * Same attach contract as Labs 07-09's `openMainLane`: `AgentHarness.create()` restores every
 * lane already recorded in the session before returning. This lab registers two read-only
 * tools (`get_booking`, `get_container_events`) and, unlike earlier labs, passes an explicit
 * `compaction` setting at creation time — `AgentHarnessOptions.compaction` — instead of
 * relying on the (much larger) harness default.
 */
export async function openMainLane(
  session: Session,
  context: Context,
  options: OpenMainLaneOptions = {},
): Promise<OpenMainLaneResult> {
  const selection = options.selection ?? modelSelectionFromEnvironment();
  const models = builtinModels();
  const model = models.getModel(selection.provider, selection.modelId);

  if (!model) {
    const available = models
      .getModels(selection.provider)
      .map((candidate) => candidate.id)
      .slice(0, 12)
      .join(", ");
    throw new Error(
      `Unknown model ${selection.provider}/${selection.modelId}. ` +
        `Available model ids include: ${available || "none"}`,
    );
  }

  const bookingRepository = BookingRepository.fromDefaultFixture();
  const containerEventRepository = ContainerEventRepository.fromDefaultFixture();
  const compaction = options.compaction ?? compactionSettingsFromEnvironment();

  const { harness, open } = await AgentHarness.create(
    {
      session,
      models,
      model,
      tools: [createGetBookingTool(bookingRepository), createGetContainerEventsTool(containerEventRepository)],
      systemPrompt: SYSTEM_PROMPT,
      compaction,
    },
    context,
  );

  const lane = await harness.lane("main", context);
  return { harness, lane, open };
}
