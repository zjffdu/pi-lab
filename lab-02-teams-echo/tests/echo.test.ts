import { describe, expect, it } from "vitest";

import { formatEcho } from "../src/echo.js";

describe("formatEcho", () => {
  it("echoes trimmed text back to the sender", () => {
    expect(formatEcho("hello")).toBe("you said: hello");
    expect(formatEcho("  hello  ")).toBe("you said: hello");
  });

  it("does not invent content for empty or whitespace-only input", () => {
    expect(formatEcho("")).toBe("I received an empty message. Send some text and I will echo it back.");
    expect(formatEcho("   ")).toBe("I received an empty message. Send some text and I will echo it back.");
  });
});
