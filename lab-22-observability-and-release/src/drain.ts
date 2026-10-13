/**
 * Graceful shutdown for the release-gate runner and the case-execution scripts: stop admitting
 * new runs, let whatever is already in flight finish, then let the process exit. This is what the
 * `shutdown-while-work-is-active` failure injection exercises — a run started *before* `drain()`
 * is called must still complete and produce a normal terminal span; a run attempted *after*
 * `drain()` has started must be rejected immediately rather than silently queued and lost.
 */
export class DrainController {
  private draining = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  public isDraining(): boolean {
    return this.draining;
  }

  public inFlightCount(): number {
    return this.inFlight.size;
  }

  public track<T>(work: Promise<T>): Promise<T> {
    if (this.draining) throw new DrainInProgressError();
    this.inFlight.add(work);
    const settle = () => this.inFlight.delete(work);
    work.then(settle, settle);
    return work;
  }

  public async drain(): Promise<void> {
    this.draining = true;
    await Promise.allSettled([...this.inFlight]);
  }
}

export class DrainInProgressError extends Error {
  public constructor() {
    super("Cannot start new work: a graceful drain is already in progress.");
    this.name = "DrainInProgressError";
  }
}
