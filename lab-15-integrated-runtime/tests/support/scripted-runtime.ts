import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import type { Message } from "@earendil-works/pi-ai";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";

import { AuditLog, type AuditRecord, createMemoryAuditLog } from "../../src/audit-log.js";
import { BookingRepository } from "../../src/booking-repository.js";
import { openIntegratedRuntime, type IntegratedRuntimeOptions } from "../../src/composition.js";
import type { ModelSelection } from "../../src/create-harness.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../../src/session-store.js";

export const ctx = BACKGROUND_CONTEXT;
export { fauxAssistantMessage };

/**
 * An assistant turn that calls one tool. It must be `toolUse`: a faux message defaults to `stop`, which
 * would end the run without executing the call.
 */
export function toolCallTurn(name: string, args: Record<string, unknown>, id: string, preamble?: string) {
  const call = fauxToolCall(name, args as never, { id });
  return fauxAssistantMessage(preamble ? [fauxText(preamble), call] : call, { stopReason: "toolUse" });
}

export function answerTurn(text: string) {
  return fauxAssistantMessage(text);
}

export function providerError(message = "provider exploded") {
  return fauxAssistantMessage([], { stopReason: "error", errorMessage: message });
}

const tempDirs: string[] = [];

/** Removes every temp directory created so far. `tests/support/setup.ts` runs it after each test file; the demo script runs it on exit. */
export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

/** A fresh temp directory for session storage, removed after the test file. */
export async function tempSessionsRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-15-"));
  tempDirs.push(dir);
  return dir;
}

/** A fixture repository that also records every status change `execute()` really performed. */
export class SpyBookingRepository extends BookingRepository {
  public readonly statusChanges: { bookingNo: string; newStatus: string }[] = [];

  public constructor() {
    super([...BookingRepository.fromDefaultFixture().all()]);
  }

  public override updateStatus(bookingNo: string, newStatus: Parameters<BookingRepository["updateStatus"]>[1]) {
    this.statusChanges.push({ bookingNo, newStatus });
    return super.updateStatus(bookingNo, newStatus);
  }
}

/** Writes every record except `after_tool`, which throws — isolates the after-phase failure. */
export function afterToolFailingAuditLog(): AuditLog {
  return new AuditLog((line) => {
    if ((JSON.parse(line) as AuditRecord).phase === "after_tool") throw new Error("Simulated audit-sink failure (after_tool only).");
  });
}

export function alwaysFailingAuditLog(): AuditLog {
  return new AuditLog(() => {
    throw new Error("Simulated audit-sink failure (every write).");
  });
}

export interface ScriptedOptions
  extends Partial<
    Pick<
      IntegratedRuntimeOptions,
      "auditLog" | "omitForContractTest" | "offeredToolNames" | "policies" | "egress" | "trace" | "repository"
    >
  > {
  /** Share one root to reopen the same session in a second runtime. */
  sessionsRoot?: string;
  sessionId?: string;
}

/**
 * The real `Harness`, real JSONL storage in a temp directory, real hooks, tracer, and telemetry bridge — with
 * only the model replaced by pi-ai's public `fauxProvider`. No network, no live model. Every provider request
 * the harness makes is captured in `providerRequests`, recorded independently of any guard under test.
 */
export async function scriptedRuntime(overrides: ScriptedOptions = {}) {
  const sessionsRoot = overrides.sessionsRoot ?? (await tempSessionsRoot());
  const sessionId = overrides.sessionId ?? "session-1";
  const { storage } = await openSessionStorage(sessionsRoot, sessionId, ctx);

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const selection: ModelSelection = { provider: model.provider, modelId: model.id };

  const providerRequests: Message[][] = [];
  const respondWith = (...steps: ReturnType<typeof fauxAssistantMessage>[]) => {
    faux.setResponses(
      steps.map(
        (message): FauxResponseStep =>
          (context) => {
            providerRequests.push([...context.messages]);
            return message;
          },
      ),
    );
  };

  const memory = createMemoryAuditLog();
  const telemetry = new InMemoryTelemetryContext();
  const runtime = await openIntegratedRuntime({
    storage,
    sessionId,
    models,
    selection,
    auditLog: overrides.auditLog ?? memory.auditLog,
    telemetry,
    ...(overrides.omitForContractTest ? { omitForContractTest: overrides.omitForContractTest } : {}),
    ...(overrides.offeredToolNames ? { offeredToolNames: overrides.offeredToolNames } : {}),
    ...(overrides.policies ? { policies: overrides.policies } : {}),
    ...(overrides.egress ? { egress: overrides.egress } : {}),
    ...(overrides.trace ? { trace: overrides.trace } : {}),
    ...(overrides.repository ? { repository: overrides.repository } : {}),
  });

  return { runtime, storage, telemetry, faux, providerRequests, respondWith, sessionsRoot, sessionId };
}

/** Plain text of every request message, so substring assertions see the real characters. */
export function requestsText(requests: readonly (readonly Message[])[]): string {
  return JSON.stringify(requests);
}

/**
 * The tool names a request actually declares to the provider. Pi writes the tool set into `system` messages
 * as *deltas* (`toolsAdded` / `toolsRemoved`), so the first system message alone is not the current set.
 */
export function declaredTools(messages: readonly Message[]): string[] {
  const tools = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const delta = message as unknown as { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };
    delta.toolsAdded?.forEach((tool) => tools.add(tool.name));
    delta.toolsRemoved?.forEach((tool) => tools.delete(tool.name));
  }
  return [...tools];
}
