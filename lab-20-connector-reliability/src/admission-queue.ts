export class OverloadedError extends Error {
  public constructor(
    public readonly reason: "queue_full" | "wait_timeout",
    public readonly retryAfterSeconds: number,
  ) {
    super(`overloaded: ${reason}`);
    this.name = "OverloadedError";
  }
}

export interface AdmissionQueueOptions {
  /** Runs executing at once. */
  maxConcurrent: number;
  /** Runs allowed to wait. One more is refused immediately. */
  maxQueued: number;
  /** Longest a run may wait for a slot. */
  maxWaitMs: number;
  /** Hint sent with the refusal. */
  retryAfterSeconds?: number;
}

interface Waiter {
  start: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Admission control in front of runs: bounded concurrency, a bounded wait line, and an explicit
 * refusal (`OverloadedError`) instead of an unbounded pile-up. A caller that leaves the line — its
 * signal aborts — is removed and never starts.
 */
export class AdmissionQueue {
  private running = 0;
  private readonly waiting: Waiter[] = [];

  public constructor(private readonly options: AdmissionQueueOptions) {}

  public get stats(): { running: number; queued: number } {
    return { running: this.running, queued: this.waiting.length };
  }

  public async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private retryAfter(): number {
    return this.options.retryAfterSeconds ?? 1;
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("aborted before admission"));
    if (this.running < this.options.maxConcurrent) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.options.maxQueued) return Promise.reject(new OverloadedError("queue_full", this.retryAfter()));

    return new Promise<void>((resolve, reject) => {
      const leave = (): void => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        leave();
        reject(new Error("aborted while queued"));
      };
      const waiter: Waiter = {
        // The slot is handed over by `release`, which has already counted it as running.
        start: () => {
          leave();
          resolve();
        },
        reject,
        timer: setTimeout(() => {
          leave();
          reject(new OverloadedError("wait_timeout", this.retryAfter()));
        }, this.options.maxWaitMs),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next.start(); // the slot passes straight to the next waiter; `running` is unchanged
    else this.running -= 1;
  }
}
