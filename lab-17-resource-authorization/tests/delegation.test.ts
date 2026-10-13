import { afterEach, describe, expect, it } from "vitest";

import { HttpBookingConnector } from "../src/booking-connector.js";
import { SCOPE_READ, SCOPE_WRITE, type DelegatedTokenProvider } from "../src/delegation.js";
import { BACKGROUND_CONTEXT, startRuntime, updateThenAnswer, type TestRuntime } from "./helpers.js";

let rt: TestRuntime;
afterEach(async () => rt?.close());

const app = { channel: "application" } as const;
const hold = { bookingNo: "BK1001", newStatus: "on_hold" };

/** Runs one allowed write and reports what the downstream made of the credential. */
async function attemptWrite(overrides: Parameters<typeof startRuntime>[0]) {
  rt = await startRuntime(overrides);
  let error: unknown;
  try {
    await rt.app.bookings.updateStatus(rt.as("alice"), hold, app);
  } catch (caught) {
    error = caught;
  }
  return { error, downstream: rt.app.downstream.log, changes: rt.app.store.statusChanges };
}

describe("delegated credential — what the downstream verifies", () => {
  it("accepts a token for the right audience, scope, and delegation, and sees the *user* as the actor", async () => {
    const { error, downstream, changes } = await attemptWrite({});
    expect(error).toBeUndefined();
    expect(downstream).toEqual([{ outcome: "applied", sub: "alice", tid: "tenant-a", scope: SCOPE_WRITE, bookingNo: "BK1001" }]);
    expect(changes[0]?.actorSubject).toBe("alice");
  });

  it("rejects a token issued for the wrong audience", async () => {
    const { error, downstream, changes } = await attemptWrite({ connectorOverrides: { audience: "api://some-other-service" } });
    expect(error).toMatchObject({ name: "ConnectorError", code: "unauthorized" });
    expect(downstream.map((entry) => entry.outcome)).toEqual(["wrong_audience"]);
    expect(changes).toEqual([]);
  });

  it("rejects a token without the write scope (the user consented to read only)", async () => {
    const { error, downstream, changes } = await attemptWrite({ consentedScopes: [SCOPE_READ] });
    expect(error).toMatchObject({ code: "forbidden" });
    expect(downstream.map((entry) => entry.outcome)).toEqual(["insufficient_scope"]);
    expect(changes).toEqual([]);
  });

  it("rejects a token that was not obtained via the assistant's delegation", async () => {
    const { error, downstream, changes } = await attemptWrite({ tokenOverrides: { omitActor: true } });
    expect(error).toMatchObject({ code: "forbidden" });
    expect(downstream.map((entry) => entry.outcome)).toEqual(["delegation_required"]);
    expect(changes).toEqual([]);
  });

  it("rejects an expired token", async () => {
    const { error, downstream, changes } = await attemptWrite({ tokenOverrides: { expiresInSeconds: -30 } });
    expect(error).toMatchObject({ code: "unauthorized" });
    expect(downstream.map((entry) => entry.outcome)).toEqual(["expired"]);
    expect(changes).toEqual([]);
  });

  it("reports an unreachable downstream as unavailable, not as a denial", async () => {
    rt = await startRuntime({ startDownstream: false });
    const error = await rt.app.bookings.updateStatus(rt.as("alice"), hold, app).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "ConnectorError", code: "unavailable" });
  });
});

describe("delegated credential — the downstream is a second, independent enforcement point", () => {
  it("refuses to change a colleague's booking even if the application layer were bypassed", async () => {
    let connector!: HttpBookingConnector;
    rt = await startRuntime({
      connector: ({ baseUrl, tokens }) => (connector = new HttpBookingConnector({ baseUrl, tokens })),
    });
    // Skips BookingService entirely: alice's own delegated token, asking for bob's booking.
    const error = await connector.updateStatus(rt.as("alice"), { bookingNo: "BK2001", newStatus: "cancelled", expectedStatus: "booked" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "not_found" });
    expect(rt.app.downstream.log.map((entry) => entry.outcome)).toEqual(["not_found"]);
    expect(rt.app.store.statusChanges).toEqual([]);
  });

  it("refuses a change based on a stale expectation", async () => {
    let connector!: HttpBookingConnector;
    rt = await startRuntime({ connector: ({ baseUrl, tokens }) => (connector = new HttpBookingConnector({ baseUrl, tokens })) });
    const error = await connector.updateStatus(rt.as("alice"), { bookingNo: "BK1001", newStatus: "cancelled", expectedStatus: "on_hold" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "conflict" });
    expect(rt.app.store.statusChanges).toEqual([]);
  });
});

describe("delegated credential — it stays inside the connector", () => {
  it("never appears in the session, the audit log, provider requests, tool results, or errors", async () => {
    const issued: string[] = [];
    rt = await startRuntime({
      connector: ({ baseUrl, tokens }) => {
        const recording: DelegatedTokenProvider = {
          async acquire(context, request) {
            const token = await tokens.acquire(context, request);
            issued.push(token);
            return token;
          },
        };
        return new HttpBookingConnector({ baseUrl, tokens: recording });
      },
    });

    rt.script(updateThenAnswer(hold, "Booking is on hold."));
    await rt.app.chat.chat(rt.as("alice"), { message: "Put BK1001 on hold" }, BACKGROUND_CONTEXT);
    expect(issued).toHaveLength(1);

    const [token] = issued as [string];
    const disk = await rt.persistedText();
    const provider = rt.providerRequests.map((request) => request.messages).join("\n");
    for (const surface of [disk, provider]) {
      expect(surface).not.toContain(token);
      expect(surface).not.toContain(token.split(".")[1] as string); // nor its claims segment
    }

    const claims = JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: "alice", tid: "tenant-a", scope: SCOPE_WRITE, act: { sub: "pi-lab-assistant" }, aud: "api://pi-lab-17-bookings" });
  });

  it("gives the model a fixed message on a downstream failure — no header, body, or token detail", async () => {
    rt = await startRuntime({ connectorOverrides: { audience: "api://some-other-service" } });
    rt.script(updateThenAnswer(hold, "It failed."));
    await rt.app.chat.chat(rt.as("alice"), { message: "Put BK1001 on hold" }, BACKGROUND_CONTEXT);
    const results = JSON.parse(rt.providerRequests[1]?.messages ?? "[]") as Array<{ role: string; content: Array<{ text: string }> }>;
    const toolResult = results.find((message) => message.role === "toolResult")?.content[0]?.text;
    // The harness wraps a tool error as `<harness>[error] …`; the message inside is the connector's fixed string.
    expect(toolResult).toContain("Booking system rejected the request (unauthorized).");
    expect(toolResult).not.toMatch(/bearer|eyJ|api:\/\//i);
  });
});
