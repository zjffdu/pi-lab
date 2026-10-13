import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BACKGROUND_CONTEXT, openSessionStorage, sessionDirectory } from "../src/session-store.js";
import { withTempSessionsRoot } from "./helpers.js";

describe("sessionDirectory", () => {
  it("maps one session id to exactly one directory under the sessions root", () => {
    expect(sessionDirectory("/root", "conversation-a")).toBe(join("/root", "conversation-a"));
    expect(sessionDirectory("/root", "conversation-a")).not.toBe(sessionDirectory("/root", "conversation-b"));
  });

  it("encodes ids so they cannot escape the sessions root", () => {
    expect(sessionDirectory("/root", "../escape")).toBe(join("/root", "..%2Fescape"));
  });

  it("rejects an empty id", () => {
    expect(() => sessionDirectory("/root", "")).toThrow(/must not be empty/);
  });
});

describe("openSessionStorage", () => {
  it("reports created on first use and reopened afterwards", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const first = await openSessionStorage(sessionsRoot, "conversation-a", BACKGROUND_CONTEXT);
      expect(first.created).toBe(true);
      await first.storage.close(BACKGROUND_CONTEXT);

      const second = await openSessionStorage(sessionsRoot, "conversation-a", BACKGROUND_CONTEXT);
      expect(second.created).toBe(false);
      expect(second.path).toBe(first.path);
      await second.storage.close(BACKGROUND_CONTEXT);
    }));

  it("gives two session ids two separate storage directories", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const a = await openSessionStorage(sessionsRoot, "conversation-a", BACKGROUND_CONTEXT);
      const b = await openSessionStorage(sessionsRoot, "conversation-b", BACKGROUND_CONTEXT);

      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
      expect((await readdir(sessionsRoot)).sort()).toEqual(["conversation-a", "conversation-b"]);

      await a.storage.close(BACKGROUND_CONTEXT);
      await b.storage.close(BACKGROUND_CONTEXT);
    }));
});
