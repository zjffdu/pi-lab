/**
 * A wall-clock budget measured on a monotonic clock. `remainingMs()` lets a caller decide *before*
 * waiting whether waiting can help, and caps each attempt's own timeout.
 *
 * Nesting is by construction: a child never outlives its parent, so a per-tool timeout cannot extend
 * the run's deadline and an attempt timeout cannot extend the tool's.
 */
export class Deadline {
  private constructor(private readonly endsAt: number) {}

  public static after(ms: number): Deadline {
    return new Deadline(performance.now() + ms);
  }

  public remainingMs(): number {
    return Math.max(0, this.endsAt - performance.now());
  }

  public expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /** The earlier of "now + ms" and this deadline. */
  public child(ms: number): Deadline {
    return new Deadline(Math.min(this.endsAt, performance.now() + ms));
  }
}
