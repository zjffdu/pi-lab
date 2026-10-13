import { TENANT_A_ONLY_TOKEN } from "../src/fake-api/server.js";
import { callThenAnswer, eventually, lookup, say, sleepMs, startHarness, type Harness, type HarnessOptions } from "../tests/helpers.js";

/**
 * A scripted (no-network) walk through the roadmap's failure injections, printing what the
 * application actually did for each: how many requests the API received, what the connector waited,
 * and what the run reported. The "model" is a script and the API is a local fake, so this shows what
 * the *application* enforces — nothing here measures a real model or a real service. Predict first
 * (WORKSHEET.md), then run it.
 */
const rows: string[][] = [];

async function scenario(name: string, options: HarnessOptions, body: (h: Harness) => Promise<string>): Promise<void> {
  const h = await startHarness(options);
  try {
    const outcome = await body(h);
    const waits = h.sleeps.length === 0 ? "-" : h.sleeps.join("+") + " ms";
    rows.push([name, String(h.api.log.length), waits, outcome]);
  } finally {
    await h.close();
  }
}

const alice = (h: Harness) => h.as("tenant-a", "alice");
const summary = (body: Record<string, any>): string =>
  `${body.status}/${body.data?.completeness ?? "-"}${body.incomplete ? ` (${body.incomplete.kind}${body.incomplete.dimension ? `:${body.incomplete.dimension}` : ""})` : ""}`;

await scenario("401/403 forbidden", { app: { connector: { credential: () => TENANT_A_ONLY_TOKEN } } }, async (h) => {
  h.script(callThenAnswer("BK1001", "could not retrieve"));
  const res = await h.as("tenant-b", "erin").chat("BK1001?");
  return `${summary(res.body)} failure=${res.body.data.lookups[0].failure.category} attempts=${res.body.data.lookups[0].failure.attempts}`;
});

await scenario("429 Retry-After: 2, then ok", {}, async (h) => {
  h.api.inject({ kind: "status", status: 429, retryAfter: "2" }, { route: "booking" });
  h.script(callThenAnswer("BK1001", "done"));
  return summary((await alice(h).chat("BK1001?")).body);
});

await scenario("429 Retry-After: 30 (beyond the wait limit)", {}, async (h) => {
  h.api.inject({ kind: "status", status: 429, retryAfter: "30" }, { route: "booking" }, Infinity);
  h.script(callThenAnswer("BK1001", "rate limited"));
  const res = await alice(h).chat("BK1001?");
  const failure = res.body.data.lookups[0].failure;
  return `${summary(res.body)} failure=${failure.category} retryAfterMs=${failure.retryAfterMs} stopped=${failure.stopped}`;
});

await scenario("503 twice, then ok", {}, async (h) => {
  h.api.inject({ kind: "status", status: 503 }, { route: "booking" }, 2);
  h.script(callThenAnswer("BK1001", "done"));
  return summary((await alice(h).chat("BK1001?")).body);
});

await scenario("503 always", {}, async (h) => {
  h.api.inject({ kind: "status", status: 503 }, { route: "booking" }, Infinity);
  h.script(callThenAnswer("BK1001", "down"));
  const res = await alice(h).chat("BK1001?");
  return `${summary(res.body)} failure=${res.body.data.lookups[0].failure.category} attempts=${res.body.data.lookups[0].failure.attempts}`;
});

await scenario("hanging request (attempt timeout 150 ms)", { app: { connector: { retry: { attemptTimeoutMs: 150 } } } }, async (h) => {
  h.api.inject({ kind: "hang" }, { route: "booking" }, Infinity);
  h.script(callThenAnswer("BK1001", "timeout"));
  const res = await alice(h).chat("BK1001?");
  await eventually(() => h.api.log.every((entry) => entry.clientAborted));
  return `${summary(res.body)} failure=${res.body.data.lookups[0].failure.category} attempts=${res.body.data.lookups[0].failure.attempts} abortedAtApi=${h.api.log.filter((entry) => entry.clientAborted).length}`;
});

await scenario("malformed JSON", {}, async (h) => {
  h.api.inject({ kind: "malformed-json" }, { route: "booking" });
  h.script(callThenAnswer("BK1001", "bad"));
  return summary((await alice(h).chat("BK1001?")).body);
});

await scenario("missing field (data.status)", {}, async (h) => {
  h.api.inject({ kind: "drop-field", field: "data.status" }, { route: "booking" });
  h.script(callThenAnswer("BK1001", "bad"));
  return summary((await alice(h).chat("BK1001?")).body);
});

await scenario("repeated pagination cursor", {}, async (h) => {
  h.api.inject({ kind: "repeat-cursor" }, { route: "containers", page: 2 });
  h.script(callThenAnswer("BK1001", "paging"));
  const res = await alice(h).chat("BK1001?");
  const lookupDetails = res.body.data.lookups[0];
  return `${summary(res.body)} retrieved=${lookupDetails.containersRetrieved}/${lookupDetails.containersExpected} total=${lookupDetails.totalWeightKg}`;
});

await scenario("partial result (page 2 fails)", {}, async (h) => {
  h.api.inject({ kind: "status", status: 503 }, { route: "containers", page: 2 }, Infinity);
  h.script(callThenAnswer("BK1001", "The total is 52250 kg."));
  const res = await alice(h).chat("BK1001 total?");
  const lookupDetails = res.body.data.lookups[0];
  return `${summary(res.body)} retrieved=${lookupDetails.containersRetrieved}/${lookupDetails.containersExpected} total=${lookupDetails.totalWeightKg} noteAdded=${res.body.answer.includes("[Application note]")}`;
});

await scenario("exhausted budget (1 tool call allowed, 2 asked)", { app: { limits: { maxToolCalls: 1 } } }, async (h) => {
  h.script([lookup("BK1001"), lookup("BK2001"), say("only one")]);
  const res = await alice(h).chat("both?");
  return `${summary(res.body)} exhausted=${res.body.budget.exhausted.join(",")} bookingsRequested=${[...new Set(h.api.log.map((entry) => entry.bookingNo))].join(",")}`;
});

await scenario("cancelled during execution", {}, async (h) => {
  h.api.inject({ kind: "hang" }, { route: "booking" }, Infinity);
  h.script(callThenAnswer("BK1001", "never"));
  const controller = new AbortController();
  const pending = alice(h).chat("BK1001?", { signal: controller.signal }).catch(() => undefined);
  await eventually(() => h.api.log.length === 1);
  controller.abort();
  await pending;
  await eventually(() => h.outcomes.some((entry) => entry.outcome === "cancelled"));
  await eventually(() => h.api.log[0]?.clientAborted === true);
  return `run=${h.outcomes.map((entry) => entry.outcome).join(",")} apiSawAbort=${h.api.log[0]?.clientAborted} modelCalls=${h.providerCalls.length}`;
});

await scenario("cancelled after the API started work", {}, async (h) => {
  h.api.inject({ kind: "delay", ms: 300 }, { route: "booking" });
  h.script(callThenAnswer("BK1001", "never"));
  const controller = new AbortController();
  const pending = alice(h).chat("BK1001?", { signal: controller.signal }).catch(() => undefined);
  await eventually(() => h.api.log.length === 1);
  controller.abort();
  await pending;
  await eventually(() => h.api.log[0]?.clientAborted === true);
  const workDoneAtAbort = h.api.workCompleted;
  await sleepMs(500);
  return `apiSawAbort=${h.api.log[0]?.clientAborted} serverWorkFinished: atAbort=${workDoneAtAbort} later=${h.api.workCompleted}`;
});

const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => (row[column] ?? "").length), ["scenario", "api requests", "waited"][column]!.length));
const line = (cells: string[]) => `${cells[0]!.padEnd(widths[0]!)} | ${cells[1]!.padEnd(widths[1]!)} | ${cells[2]!.padEnd(widths[2]!)} | ${cells[3]}`;
console.log(line(["scenario", "api requests", "waited", "result"]));
for (const row of rows) console.log(line(row));
