import { BudgetExhaustedError, type AttemptBudget, type BudgetDimension } from "./connector/errors.js";
import { Deadline } from "./connector/deadline.js";

export interface BudgetLimits {
  /** Settled assistant messages in one request. */
  maxTurns: number;
  maxToolCalls: number;
  /** Paginated fetches across the whole run (not HTTP attempts). */
  maxPages: number;
  /** HTTP attempts to the booking API across the whole run, retries included. */
  maxConnectorAttempts: number;
  /** Size of the message history sent to the model, in characters (a coarse stand-in for tokens). */
  maxContextChars: number;
  /** Cap on one model response; passed to the provider as the model's max output tokens. */
  maxOutputTokens: number;
  /** One tool result shown to the model; the rest is dropped with an explicit marker. */
  maxToolResultChars: number;
  runDeadlineMs: number;
  /** One tool call, retries and pages included. */
  toolTimeoutMs: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxTurns: 6,
  maxToolCalls: 4,
  maxPages: 8,
  maxConnectorAttempts: 10,
  maxContextChars: 24_000,
  maxOutputTokens: 800,
  maxToolResultChars: 2_400,
  runDeadlineMs: 30_000,
  toolTimeoutMs: 10_000,
};

export interface BudgetUsage {
  turns: number;
  toolCalls: number;
  pages: number;
  connectorAttempts: number;
}

/**
 * One request's limits and what has been spent. A reservation is made *before* the thing it pays
 * for and throws `BudgetExhaustedError` when the limit is already reached, so an exhausted budget
 * means "nothing further is dispatched" — it says nothing about a call that was already in flight,
 * which is neither cancelled nor refunded by exhaustion.
 *
 * Exhaustion is per dimension and sticky: running out of pages stops page fetches but not the final
 * answer; running out of turns stops the run.
 */
export class RunBudget implements AttemptBudget {
  public readonly usage: BudgetUsage = { turns: 0, toolCalls: 0, pages: 0, connectorAttempts: 0 };
  public readonly deadline: Deadline;
  private readonly exhausted = new Set<BudgetDimension>();

  public constructor(public readonly limits: BudgetLimits) {
    this.deadline = Deadline.after(limits.runDeadlineMs);
  }

  private reserve(dimension: BudgetDimension, key: keyof BudgetUsage, limit: number): void {
    if (this.usage[key] >= limit) {
      this.exhausted.add(dimension);
      throw new BudgetExhaustedError(dimension);
    }
    this.usage[key] += 1;
  }

  public reserveToolCall(): void {
    this.reserve("tool_calls", "toolCalls", this.limits.maxToolCalls);
  }

  public reservePage(): void {
    this.reserve("pages", "pages", this.limits.maxPages);
  }

  /** Only for a page whose request was never sent; a page that was dispatched stays spent. */
  public releasePage(): void {
    if (this.usage.pages > 0) this.usage.pages -= 1;
  }

  public reserveAttempt(): void {
    this.reserve("connector_attempts", "connectorAttempts", this.limits.maxConnectorAttempts);
  }

  /** A settled assistant message. Turns cannot be refused after the fact, only stopped before the next one. */
  public recordTurn(): void {
    this.usage.turns += 1;
  }

  public turnLimitReached(): boolean {
    return this.usage.turns >= this.limits.maxTurns;
  }

  public markExhausted(dimension: BudgetDimension): void {
    this.exhausted.add(dimension);
  }

  public isExhausted(dimension: BudgetDimension): boolean {
    return this.exhausted.has(dimension);
  }

  public exhaustedDimensions(): BudgetDimension[] {
    return [...this.exhausted];
  }
}
