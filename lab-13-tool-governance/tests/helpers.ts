import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";

import { AuditLog, type AuditRecord } from "../src/audit-log.js";
import { BookingRepository } from "../src/booking-repository.js";
import type { ModelSelection } from "../src/create-harness.js";

/**
 * A scripted model: nothing in the test suite calls a real provider. `faux.setResponses()` queues one
 * assistant message (or a factory that sees the request's transcript) per model request.
 */
export function createFauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const selection: ModelSelection = { provider: model.provider, modelId: model.id };
  return { faux, models, selection };
}

export async function withTempSessionsRoot<T>(body: (sessionsRoot: string) => Promise<T>): Promise<T> {
  const sessionsRoot = await mkdtemp(join(tmpdir(), "pi-lab-13-"));
  try {
    return await body(sessionsRoot);
  } finally {
    await rm(sessionsRoot, { recursive: true, force: true });
  }
}

export function recordingAuditLog(): { auditLog: AuditLog; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  const auditLog = new AuditLog((line) => {
    records.push(JSON.parse(line) as AuditRecord);
  });
  return { auditLog, records };
}

/** Writes `before_tool` records normally and throws for `after_tool` — isolates the after-phase failure. */
export function afterToolFailingAuditLog(): { auditLog: AuditLog; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  const auditLog = new AuditLog((line) => {
    const parsed = JSON.parse(line) as AuditRecord;
    if (parsed.phase === "after_tool") {
      throw new Error("Simulated audit-sink failure (after_tool phase only).");
    }
    records.push(parsed);
  });
  return { auditLog, records };
}

export function alwaysFailingAuditLog(): AuditLog {
  return new AuditLog(() => {
    throw new Error("Simulated audit-sink failure (every write).");
  });
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
