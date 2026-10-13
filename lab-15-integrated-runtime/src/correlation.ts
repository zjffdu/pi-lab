/**
 * The correlation envelope: where each identity comes from, and the one place the application attaches
 * the ones Pi does not carry.
 *
 * Pi 1.1 gives a hook `api.conversationId`, `api.taskId`, and the call's `id` — and no run id, lane, or turn
 * id. A submission has its own durable id and takes an application `requestId`, but the tool task a hook
 * runs in is not linked to it by any id: a `pi.tool` task's `owner` is the generation task, whose `input` is
 * empty. So a hook cannot read its request from Pi, and `RequestBindings` supplies it.
 *
 * The binding is checked, not trusted: `verifyMechanism` re-derives each audit record's request from durable
 * state (the tool task's assistant entry must lie inside the request's own entry range) and fails a run
 * where the two disagree.
 */
export interface RequestEnvelope {
  /** Application-supplied. Also the submission's own `requestId`, which Pi stores and deduplicates on. */
  requestId: string;
  /** Application-supplied: storage knows no external session id. */
  sessionId: string;
}

/**
 * `conversationId -> request in flight`. A conversation runs one request at a time here (the composition
 * root awaits each), so one slot per conversation is enough. A hook that finds no slot — a recovered run
 * after a restart — gets `null`, and the audit record says so rather than inventing a request id.
 */
export class RequestBindings {
  private readonly inFlight = new Map<number, RequestEnvelope>();

  public set(conversationId: number, request: RequestEnvelope): void {
    const existing = this.inFlight.get(conversationId);
    if (existing) {
      throw new Error(`Request ${existing.requestId} is still in flight on conversation ${conversationId}; one request per conversation at a time.`);
    }
    this.inFlight.set(conversationId, request);
  }

  public clear(conversationId: number): void {
    this.inFlight.delete(conversationId);
  }

  public current(conversationId: number): RequestEnvelope | null {
    return this.inFlight.get(conversationId) ?? null;
  }
}

/**
 * Deterministic identity of "what this tool call was going to do to the business". Application-defined, not
 * Pi-defined. It names an *attempt*: a blocked call has one too, and only the effect ledger says an action
 * actually happened. Built from ids Pi keeps stable across a recovery rerun.
 */
export function businessActionIdFor(conversationId: number, taskId: number): string {
  return `act:${conversationId}:${taskId}`;
}
