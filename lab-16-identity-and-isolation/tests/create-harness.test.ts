import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

import { TenantBookingStore } from "../src/booking-store.js";
import { assertModelAvailable, createRequestRegistry, modelSelectionFromEnvironment, openHarness } from "../src/create-harness.js";
import { createProviderBoundary } from "../src/provider-boundary.js";
import { ScopedCache } from "../src/scoped-cache.js";
import { mintSecurityContextForTest } from "../src/security-context.js";
import { BACKGROUND_CONTEXT, openSessionStorage } from "../src/session-store.js";
import { listEntries, messageText } from "../src/transcript.js";
import { createFauxModels, withTempSessionsRoot } from "./support.js";

const ctx = BACKGROUND_CONTEXT;
const store = TenantBookingStore.fromDefaultFixture();
const principal = (tenantId: string, subject: string) => mintSecurityContextForTest({ tenantId, subject, requestId: "r" });

describe("model selection", () => {
  it("defaults to a model id that exists in the Pi 1.1 catalog", () => {
    const selection = modelSelectionFromEnvironment({});
    expect(selection).toEqual({ provider: "deepseek", modelId: "deepseek-flash" });
    // The 0.85.1 default, `deepseek-v4-flash`, is not in the 1.1 catalog; only resolving the id catches that.
    expect(() => assertModelAvailable({ models: builtinModels(), selection })).not.toThrow();
  });

  it("fails at startup, naming real ids, for an unknown model", () => {
    expect(() =>
      assertModelAvailable({ models: builtinModels(), selection: { provider: "deepseek", modelId: "deepseek-v4-flash" } }),
    ).toThrow(/Unknown model deepseek\/deepseek-v4-flash. Available model ids include: .*deepseek-flash/);
  });
});

describe("a reopened session is governed by the current caller, not by whoever created it", () => {
  it("the same session directory, opened later under another principal, looks bookings up in that principal's tenant", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const lookup = fauxAssistantMessage(fauxToolCall("get_booking", { bookingNo: "BK1001" }, { id: "call-1" }), { stopReason: "toolUse" });

      async function askAs(security: ReturnType<typeof principal>) {
        const { faux, models, selection } = createFauxModels();
        faux.setResponses([lookup, fauxAssistantMessage("ok")]);
        const { storage } = await openSessionStorage(sessionsRoot, "shared-dir", "s1", ctx);
        const requestRegistry = createRequestRegistry({ securityContext: security, store, cache: new ScopedCache() });
        const { harness, root } = await openHarness(storage, { binding: { models, selection }, requestRegistry }, ctx);
        await (await root.submit({ type: "input", content: "BK1001?" }, ctx)).wait(ctx);
        const toolResults = (await listEntries(root, ctx)).flatMap((entry) => (entry.model?.[0]?.role === "toolResult" ? [messageText(entry.model[0])] : []));
        await harness.close(ctx);
        return toolResults.join("\n");
      }

      // Same storage, same stored tool offer; only the installed registry — built for this request's
      // SecurityContext — differs. Nothing principal-dependent was stored by the first run.
      const first = await askAs(principal("tenant-a", "alice"));
      const second = await askAs(principal("tenant-b", "carol"));

      expect(first).toContain("ALPHA EXPRESS");
      expect(first).not.toContain("BRAVO VOYAGER");
      expect(second).toContain("BRAVO VOYAGER");
      // The reopened session still contains the first principal's earlier tool result in its history;
      // that is why a session must only ever be opened for its registered owner (SessionRegistry).
      expect(second).toContain("ALPHA EXPRESS");
    }));
});

describe("the provider boundary is installed and sees every request", () => {
  it("records a request that contains a forbidden text — and the provider still receives it", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, models, selection } = createFauxModels();
      faux.setResponses([fauxAssistantMessage("hello")]);
      const boundary = createProviderBoundary();
      boundary.forbid("TCLU9999999");

      const { storage } = await openSessionStorage(sessionsRoot, "tenant-a", "s1", ctx);
      const requestRegistry = createRequestRegistry({ securityContext: principal("tenant-a", "alice"), store, cache: new ScopedCache(), boundary });
      const { harness, root } = await openHarness(storage, { binding: { models, selection }, requestRegistry }, ctx);
      await (await root.submit({ type: "input", content: "mention TCLU9999999" }, ctx)).wait(ctx);
      await harness.close(ctx);

      expect(boundary.requests).toHaveLength(1);
      expect(boundary.violations).toHaveLength(1);
      // The 1.1 contract: a hook cannot stop the request.
      expect(faux.state.callCount).toBe(1);
    }));

  it("records nothing for a request that contains none of the forbidden texts", () =>
    withTempSessionsRoot(async (sessionsRoot) => {
      const { faux, models, selection } = createFauxModels();
      faux.setResponses([fauxAssistantMessage("hello")]);
      const boundary = createProviderBoundary();
      boundary.forbid(...store.foreignMarkers(principal("tenant-a", "alice")));

      const { storage } = await openSessionStorage(sessionsRoot, "tenant-a", "s1", ctx);
      const requestRegistry = createRequestRegistry({ securityContext: principal("tenant-a", "alice"), store, cache: new ScopedCache(), boundary });
      const { harness, root } = await openHarness(storage, { binding: { models, selection }, requestRegistry }, ctx);
      await (await root.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
      await harness.close(ctx);

      expect(boundary.requests).toHaveLength(1);
      expect(boundary.violations).toEqual([]);
      expect(boundary.forbiddenCount).toBeGreaterThan(0);
    }));
});
