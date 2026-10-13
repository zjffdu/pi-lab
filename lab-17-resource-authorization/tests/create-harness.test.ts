import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { assertModelAvailable, modelSelectionFromEnvironment, offeredToolNames, openHarness, createBookingRegistry } from "../src/create-harness.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { startRuntime, type TestRuntime } from "./helpers.js";

let rt: TestRuntime;
afterEach(async () => rt?.close());

describe("model selection", () => {
  it("defaults to a model id the Pi 1.1 catalog actually contains", () => {
    const selection = modelSelectionFromEnvironment({});
    expect(selection).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
    expect(() => assertModelAvailable(builtinModels(), selection)).not.toThrow();
  });

  it("fails at startup, naming real ids, for the 0.85.1-era id that no longer exists", () => {
    const stale = modelSelectionFromEnvironment({ PI_MODEL: "deepseek-v4-flash" });
    expect(() => assertModelAvailable(builtinModels(), stale)).toThrow(/Unknown model deepseek\/deepseek-v4-flash.*deepseek-flash/);
  });
});

describe("an unknown model", () => {
  it("fails when the app is created, before any request can write a session record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-lab-17-badmodel-"));
    try {
      const faux = fauxProvider();
      const models = createModels();
      models.setProvider(faux.provider);
      await expect(createApp({ binding: { models, selection: { provider: "deepseek", modelId: "deepseek-v4-flash" } }, dataDir: dir })).rejects.toThrow(
        /Unknown model deepseek\/deepseek-v4-flash/,
      );
      expect(await readdir(dir)).toEqual([]); // no registry.jsonl, no sessions/
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("openHarness applies today's offer to the conversation", () => {
  async function open(subject: string, offered: string[], sessionId = "s") {
    const security = rt.as(subject);
    const { storage } = await openSessionStorage(rt.app.paths.sessionsRoot, security.tenantId, sessionId, BACKGROUND_CONTEXT);
    const booking = createBookingRegistry({ security, bookings: rt.app.bookings });
    return openHarness(storage, { binding: rt.binding, booking, offeredToolNames: offered }, BACKGROUND_CONTEXT);
  }

  it("a new conversation offers exactly today's tools, and reports no restored offer beyond them", async () => {
    rt = await startRuntime();
    const opened = await open("erin", ["get_booking"]);
    expect(await offeredToolNames(opened.root, BACKGROUND_CONTEXT)).toEqual(["get_booking"]);
    expect(opened.restoredOffer).toEqual(["get_booking"]);
    await opened.harness.close(BACKGROUND_CONTEXT);
  });

  it("a reopened conversation reports the stored offer as `restoredOffer`, then replaces it", async () => {
    rt = await startRuntime();
    const first = await open("alice", ["get_booking", "update_booking_status"]);
    await first.harness.close(BACKGROUND_CONTEXT);

    const second = await open("alice", ["get_booking"]);
    expect(second.restoredOffer).toEqual(["get_booking", "update_booking_status"]);
    expect(await offeredToolNames(second.root, BACKGROUND_CONTEXT)).toEqual(["get_booking"]);
    await second.harness.close(BACKGROUND_CONTEXT);

    // Replacing it is durable: a later process that is *not* told to restrict still inherits the reduced offer.
    const third = await open("alice", ["get_booking"]);
    expect(third.restoredOffer).toEqual(["get_booking"]);
    await third.harness.close(BACKGROUND_CONTEXT);
  });

  it("does not start any scheduling while it restricts the offer", async () => {
    rt = await startRuntime();
    const first = await open("alice", ["get_booking", "update_booking_status"]);
    await first.harness.close(BACKGROUND_CONTEXT);
    const second = await open("alice", ["get_booking"]);
    expect((await second.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
    await second.harness.close(BACKGROUND_CONTEXT);
  });

  it("refuses a tool name that is not part of the lab", async () => {
    rt = await startRuntime();
    await expect(open("alice", ["get_booking", "drop_database"])).rejects.toThrow(/Unknown tool name in the offer: drop_database/);
  });
});
