import { describe, expect, it } from "vitest";

import { ContainerEventRepository } from "../src/container-event-repository.js";
import {
  ContainerEventsNotFoundError,
  createGetContainerEventsTool,
} from "../src/get-container-events-tool.js";

describe("get_container_events", () => {
  const repository = ContainerEventRepository.fromDefaultFixture();
  const tool = createGetContainerEventsTool(repository);

  it("returns structured fixture evidence", async () => {
    const result = await tool.execute(
      "call-1",
      { containerNo: "MSKU1234567" },
      new AbortController().signal,
    );

    expect(result.details).toEqual({ containerNo: "MSKU1234567", eventCount: 3 });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(repository.findByContainerNo("MSKU1234567")),
      },
    ]);
  });

  it("throws a typed error for an unknown container", async () => {
    await expect(
      tool.execute("call-2", { containerNo: "UNKNOWN0000" }, new AbortController().signal),
    ).rejects.toEqual(new ContainerEventsNotFoundError("UNKNOWN0000"));
  });
});
