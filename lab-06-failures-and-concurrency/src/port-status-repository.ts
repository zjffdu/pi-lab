import { readFileSync } from "node:fs";

export type CongestionLevel = "low" | "medium" | "high";

export interface PortStatus {
  portCode: string;
  congestionLevel: CongestionLevel;
  observedAt: string;
}

const CONGESTION_LEVELS: readonly CongestionLevel[] = ["low", "medium", "high"];

function isPortStatus(value: unknown): value is PortStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.portCode === "string" &&
    typeof candidate.congestionLevel === "string" &&
    CONGESTION_LEVELS.includes(candidate.congestionLevel as CongestionLevel) &&
    typeof candidate.observedAt === "string"
  );
}

export class PortStatusRepository {
  public constructor(private readonly statuses: readonly PortStatus[]) {}

  public static fromDefaultFixture(): PortStatusRepository {
    const fixtureUrl = new URL("../data/port-status.json", import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));

    if (!Array.isArray(parsed) || !parsed.every(isPortStatus)) {
      throw new Error("data/port-status.json does not contain a valid status array");
    }

    return new PortStatusRepository(parsed);
  }

  public findByPortCode(portCode: string): PortStatus | undefined {
    return this.statuses.find((status) => status.portCode === portCode);
  }
}
