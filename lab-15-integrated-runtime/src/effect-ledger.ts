import type { StatusChange } from "./update-booking-status-tool.js";
import { businessActionIdFor } from "./correlation.js";

/**
 * A business effect: something that actually changed in the (simulated) business system. Deliberately
 * separate from a tool *outcome* ("the tool call returned") and from the assistant's *answer* ("I changed
 * it"). The only writer is the status-change tool's own callback, at the moment its mutation succeeded.
 */
export interface EffectRecord extends StatusChange {
  businessActionId: string;
}

export class EffectLedger {
  private readonly effects: EffectRecord[] = [];

  /** Pass to `createUpdateBookingStatusTool(repository, ledger.onChange)`. */
  public readonly onChange = (change: StatusChange): void => {
    this.effects.push({ ...change, businessActionId: businessActionIdFor(change.conversationId, change.taskId) });
  };

  public list(): readonly EffectRecord[] {
    return [...this.effects];
  }

  /** Effects made by these tool tasks — how a request's effects are told apart from an earlier request's. */
  public forTasks(taskIds: ReadonlySet<number>): EffectRecord[] {
    return this.effects.filter((effect) => taskIds.has(effect.taskId));
  }
}
