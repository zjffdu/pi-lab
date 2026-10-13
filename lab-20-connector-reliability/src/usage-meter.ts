import type { Usage } from "@earendil-works/pi-ai";

export interface Pricing {
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export type CostReport = { usd: number; source: "configured-pricing" } | { usd: "unavailable"; reason: string };

export interface UsageReport {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: CostReport;
}

/** Reads `PRICE_INPUT_PER_MTOK` / `PRICE_OUTPUT_PER_MTOK`; anything missing or not a number means "no pricing". */
export function pricingFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Pricing | undefined {
  const input = Number(environment.PRICE_INPUT_PER_MTOK);
  const output = Number(environment.PRICE_OUTPUT_PER_MTOK);
  if (!environment.PRICE_INPUT_PER_MTOK?.trim() || !environment.PRICE_OUTPUT_PER_MTOK?.trim()) return undefined;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return undefined;
  return { inputPerMTokUsd: input, outputPerMTokUsd: output };
}

/**
 * Accumulates the provider-reported token counts for each settled model response. Cost is computed
 * only from *configured* pricing. The SDK's own `usage.cost` is not used: a model with no known
 * price reports zero there, and "zero" would be read as "free" instead of "unknown".
 */
export class UsageMeter {
  private modelCalls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private totalTokens = 0;

  public constructor(private readonly pricing: Pricing | undefined) {}

  public record(usage: Usage): void {
    this.modelCalls += 1;
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.totalTokens += usage.totalTokens;
  }

  public report(): UsageReport {
    const cost: CostReport = this.pricing
      ? { usd: (this.inputTokens * this.pricing.inputPerMTokUsd + this.outputTokens * this.pricing.outputPerMTokUsd) / 1_000_000, source: "configured-pricing" }
      : { usd: "unavailable", reason: "no pricing configured for this model" };
    return { modelCalls: this.modelCalls, inputTokens: this.inputTokens, outputTokens: this.outputTokens, totalTokens: this.totalTokens, cost };
  }
}
