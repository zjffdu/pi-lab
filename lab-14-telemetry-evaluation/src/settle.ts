import type { AgentEvent, SubmissionId } from "@earendil-works/pi-durable";

/**
 * `watchEvents` is a stream derived from storage commits, delivered asynchronously: when
 * `submission.wait()` returns, the consumer may not have seen the run's events yet. A terminal `submission`
 * event (`done` or `unanswered`) is delivered after `run_end`, so waiting for it means "every event of this
 * submission's run has been consumed". `WatchHandle.stop()` only promises to stop future callbacks, not to
 * flush pending frames — callers wait here first, then stop.
 */
export interface SettleTracker {
  observe(event: AgentEvent): void;
  /** Resolves once the terminal `submission` event arrived; on timeout calls `onTimeout` and resolves anyway. */
  settled(submissionId: SubmissionId, timeoutMs: number | undefined, onTimeout: (message: string) => void): Promise<void>;
}

export function createSettleTracker(): SettleTracker {
  const settledIds = new Set<SubmissionId>();
  const waiters = new Map<SubmissionId, () => void>();

  return {
    observe(event) {
      if (event.type === "submission" && (event.record.status === "done" || event.record.status === "unanswered")) {
        settledIds.add(event.record.id);
        waiters.get(event.record.id)?.();
      }
    },
    settled(submissionId, timeoutMs = 5000, onTimeout) {
      if (settledIds.has(submissionId)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(submissionId);
          onTimeout(`no settle event for submission ${submissionId} within ${timeoutMs}ms`);
          resolve();
        }, timeoutMs);
        waiters.set(submissionId, () => {
          clearTimeout(timer);
          waiters.delete(submissionId);
          resolve();
        });
      });
    },
  };
}
