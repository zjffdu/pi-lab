import {
  AgentHarness,
  type AgentLane,
  type Context,
  type OpenOperation,
  type Session,
} from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { BookingRepository } from "./booking-repository.js";
import { entryProjectors as caseNoteEntryProjectors } from "./entry-projectors.js";
import { createGetBookingTool } from "./get-booking-tool.js";
import { createGuardedToProviderMessages, type ProviderBoundaryViolation } from "./provider-boundary.js";

const SYSTEM_PROMPT = `You are a booking-operations assistant in a learning lab.

Rules:
- Call get_booking before making any claim about a booking's route or vessel. Read-only.
- Some of what you are told may come from an internal case-management note written into this
  conversation for you, not from get_booking. Treat it exactly like any other message you can
  see: use it, but never invent additional detail beyond what you were actually shown.
- If asked about something you were never shown — including anything you were not given
  permission to see — say plainly that you do not have that information. Do not guess or try
  to reconstruct it from context.
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

export interface OpenMainLaneResult {
  harness: AgentHarness;
  lane: AgentLane;
  /** Lanes with a durable operation left open when the harness attached to this session. */
  open: OpenOperation[];
}

export interface OpenMainLaneOptions {
  selection?: ModelSelection;
  /**
   * Omitted (the default) reproduces this lab's "no projector" arm of the mental model:
   * `buildSessionContext()` finds no `entryProjectors` entry for customType `"case_note"`, so
   * every `case_note` entry — `"shared"` or `"internal"` — contributes zero context messages,
   * regardless of visibility. Pass `true` to wire this lab's one projector
   * (`entry-projectors.ts`) and get the "approved subset" arm instead.
   */
  withCaseNoteProjection?: boolean;
  /** Forwarded to `createGuardedToProviderMessages`. Empty by default: no check runs. */
  forbiddenProviderSubstrings?: readonly string[];
  /**
   * Forwarded to `createGuardedToProviderMessages`. Defaults to throwing immediately — a
   * silent default here would make this lab's one safety net silently do nothing.
   */
  onProviderBoundaryViolation?: (violation: ProviderBoundaryViolation) => void;
}

const DEFAULT_ON_VIOLATION = (violation: ProviderBoundaryViolation): never => {
  throw new Error(
    `Provider-boundary violation: forbidden text "${violation.matchedText}" found in provider ` +
      `message #${violation.messageIndex}`,
  );
};

/**
 * Same attach contract as Labs 07-11's `openMainLane`: `AgentHarness.create()` restores every
 * lane already recorded in the session before returning. This lab registers the same
 * `get_booking` read-only tool earlier labs use for grounding, and adds two options with no
 * equivalent in any earlier lab: `entryProjectors` (only wired when `withCaseNoteProjection` is
 * `true`) and a `toProviderMessages` override that is always wired, so the provider-boundary
 * check runs on every request regardless of which projection arm is under test.
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
  const forbiddenProviderSubstrings = options.forbiddenProviderSubstrings ?? [];
  const onProviderBoundaryViolation = options.onProviderBoundaryViolation ?? DEFAULT_ON_VIOLATION;

  const { harness, open } = await AgentHarness.create(
    {
      session,
      models,
      model,
      tools: [createGetBookingTool(bookingRepository)],
      systemPrompt: SYSTEM_PROMPT,
      entryProjectors: options.withCaseNoteProjection ? caseNoteEntryProjectors : undefined,
      toProviderMessages: createGuardedToProviderMessages(forbiddenProviderSubstrings, onProviderBoundaryViolation),
    },
    context,
  );

  const lane = await harness.lane("main", context);
  return { harness, lane, open };
}
