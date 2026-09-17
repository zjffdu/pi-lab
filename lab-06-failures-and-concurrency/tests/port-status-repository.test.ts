import { describe, expect, it } from "vitest";

import { PortStatusRepository } from "../src/port-status-repository.js";

describe("PortStatusRepository", () => {
  const repository = PortStatusRepository.fromDefaultFixture();

  it("returns the fixture status by exact port code", () => {
    expect(repository.findByPortCode("CNSHA")).toEqual({
      portCode: "CNSHA",
      congestionLevel: "high",
      observedAt: "2026-09-10T12:00:00Z",
    });
  });

  it("returns undefined for an unknown port", () => {
    expect(repository.findByPortCode("USXXX")).toBeUndefined();
  });
});
