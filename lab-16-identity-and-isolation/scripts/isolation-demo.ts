import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

import { bearer, lookupThenAnswer, startHarness } from "../tests/helpers.js";

/**
 * Runs the roadmap's two prediction-gate scenarios plus the identity failure injections against a
 * real local HTTP server and a scripted model (no live model calls). Run it AFTER you have written
 * your predictions in WORKSHEET.md — its output is the observation, not a hint.
 */
const h = await startHarness();
const rows: Array<{ scenario: string; status: number | string; detail: string }> = [];

async function as(tenant: string, sub: string, message: string, sessionId?: string) {
  const token = await h.token({ tid: tenant, sub });
  return h.post("/v1/chat", sessionId ? { message, sessionId } : { message }, bearer(token));
}

const providerSaw = () => {
  const seen = h.providerRequests.join("\n");
  return `provider saw ALPHA=${seen.includes("ALPHA EXPRESS")} BRAVO=${seen.includes("BRAVO VOYAGER")}`;
};

// 1. Two tenants query their own BK1001.
for (const [tenant, sub, vessel] of [
  ["tenant-a", "alice", "ALPHA EXPRESS"],
  ["tenant-b", "carol", "BRAVO VOYAGER"],
] as const) {
  h.providerRequests.length = 0;
  h.script(lookupThenAnswer("BK1001", `BK1001 sails on ${vessel}.`));
  const response = await as(tenant, sub, "Where is BK1001?");
  rows.push({ scenario: `${tenant}/${sub} asks about BK1001`, status: response.status, detail: providerSaw() });
}

// 2. Another user's session ID.
h.script([fauxAssistantMessage(fauxText("Noted."))]);
const owned = await as("tenant-a", "alice", "Private note: my container is MSKU1111111");
const sessionId = owned.body.sessionId as string;
const callsBefore = h.faux.state.callCount;
for (const [tenant, sub] of [
  ["tenant-a", "bob"],
  ["tenant-b", "carol"],
] as const) {
  const token = await h.token({ tid: tenant, sub });
  const history = await h.get(`/v1/sessions/${sessionId}/messages`, bearer(token));
  const chat = await as(tenant, sub, "What did alice say?", sessionId);
  rows.push({ scenario: `${tenant}/${sub} reads alice's session history by ID`, status: history.status, detail: JSON.stringify(history.body.error ?? "history returned") });
  rows.push({ scenario: `${tenant}/${sub} continues alice's session by ID`, status: chat.status, detail: JSON.stringify(chat.body.error ?? "answer returned") });
}
rows.push({ scenario: "model calls made by the denied attempts", status: "-", detail: String(h.faux.state.callCount - callsBefore) });

// 3. Identity failure injections.
const injections: Array<[string, Record<string, string>]> = [
  ["expired token", bearer(await h.token({ tid: "tenant-a", sub: "alice", expiresInSeconds: -60 }))],
  ["wrong audience", bearer(await h.token({ tid: "tenant-a", sub: "alice", audience: "api://other" }))],
  ["forged tenant header, no token", { "x-tenant-id": "tenant-b" }],
];
for (const [name, headers] of injections) {
  const callsBeforeInjection = h.faux.state.callCount;
  const response = await h.post("/v1/chat", { message: "BK1001?" }, headers);
  rows.push({ scenario: name, status: response.status, detail: `model calls=${h.faux.state.callCount - callsBeforeInjection}` });
}

const validToken = await h.token({ tid: "tenant-a", sub: "alice" });
h.providerRequests.length = 0;
h.script(lookupThenAnswer("BK1001", "ok"));
const upgraded = await h.post("/v1/chat", { message: "BK1001?" }, { ...bearer(validToken), "x-tenant-id": "tenant-b" });
rows.push({ scenario: "valid tenant-a token + forged x-tenant-id: tenant-b", status: upgraded.status, detail: providerSaw() });
rows.push({ scenario: "server-side auth failure reasons (never sent to clients)", status: "-", detail: h.authFailures.join(", ") });

console.table(rows);
await h.close();
