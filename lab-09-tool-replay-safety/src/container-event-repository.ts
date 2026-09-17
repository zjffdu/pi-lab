import { readFileSync } from "node:fs";

export type ContainerEventType = "GATE_IN" | "LOAD" | "DEPARTURE" | "DISCHARGE" | "GATE_OUT";

export interface ContainerEvent {
  containerNo: string;
  eventType: ContainerEventType;
  timestamp: string;
  location: string;
}

const EVENT_TYPES: readonly ContainerEventType[] = [
  "GATE_IN",
  "LOAD",
  "DEPARTURE",
  "DISCHARGE",
  "GATE_OUT",
];

function isContainerEvent(value: unknown): value is ContainerEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.containerNo === "string" &&
    typeof candidate.eventType === "string" &&
    EVENT_TYPES.includes(candidate.eventType as ContainerEventType) &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.location === "string"
  );
}

export class ContainerEventRepository {
  public constructor(private readonly events: readonly ContainerEvent[]) {}

  public static fromDefaultFixture(): ContainerEventRepository {
    const fixtureUrl = new URL("../data/container-events.json", import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));

    if (!Array.isArray(parsed) || !parsed.every(isContainerEvent)) {
      throw new Error("data/container-events.json does not contain a valid event array");
    }

    return new ContainerEventRepository(parsed);
  }

  /** Events for one container, ordered oldest to newest. Empty when the container is unknown. */
  public findByContainerNo(containerNo: string): ContainerEvent[] {
    return this.events
      .filter((event) => event.containerNo === containerNo)
      .toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
}
