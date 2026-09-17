import { describe, expect, it } from "vitest";

import { createGetPortStatusTool, PortStatusNotFoundError } from "../src/get-port-status-tool.js";
import { PortStatusRepository } from "../src/port-status-repository.js";

describe("get_port_status", () => {
  const repository = PortStatusRepository.fromDefaultFixture();
  const tool = createGetPortStatusTool(repository);

  it("returns structured fixture evidence", async () => {
    const result = await tool.execute(
      "call-1",
      { portCode: "CNSHA" },
      new AbortController().signal,
    );

    expect(result.details).toEqual({ portCode: "CNSHA" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(repository.findByPortCode("CNSHA")),
      },
    ]);
  });

  it("throws a typed error for an unknown port", async () => {
    await expect(
      tool.execute("call-2", { portCode: "USXXX" }, new AbortController().signal),
    ).rejects.toEqual(new PortStatusNotFoundError("USXXX"));
  });

  it("honors an artificial delay before resolving", async () => {
    const delayedTool = createGetPortStatusTool(repository, { artificialDelayMs: 20 });
    const start = Date.now();

    await delayedTool.execute("call-3", { portCode: "CNSHA" }, new AbortController().signal);

    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});
