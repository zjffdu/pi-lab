import { config } from "dotenv";

import { systemClock } from "../src/action-service.js";
import { createPool, databaseUrl } from "../src/db.js";
import { PrincipalDirectory, loadTenantFixture } from "../src/directory.js";
import { ManualReview, type Resolution } from "../src/manual-review.js";
import { OutboxStore } from "../src/outbox.js";
import { Policy } from "../src/policy.js";
import { mintSecurityContextForTest } from "../src/security-context.js";

/**
 * Inspect the outbox and resolve manual-review rows. Used by RUNBOOK.md. Reads DATABASE_URL from .env
 * and works on the default schema (`SCHEMA=<name>` selects another).
 *
 *   npm run --silent outbox -- list [status]
 *   npm run --silent outbox -- show <outboxId>
 *   npm run --silent outbox -- review <tenant> <approver> applied <outboxId> <toVersion> "<note>"
 *   npm run --silent outbox -- review <tenant> <approver> not-applied <outboxId> "<note>"
 *   npm run --silent outbox -- review <tenant> <approver> redeliver <outboxId> "<note>" --accept-duplicate-risk
 *
 * `list` and `show` are not tenant-scoped (operator inspection only); `review` is. The reviewer identity here is a local test principal from data/tenants.json — this CLI stands in for
 * an authenticated operator console; it is not a production authentication path.
 */
config({ quiet: true });
const [command, ...args] = process.argv.slice(2);
const pool = createPool(databaseUrl(), process.env.SCHEMA);
const store = new OutboxStore(pool, systemClock);

const show = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  if (command === "list") {
    const status = args[0];
    const rows = await store.list(status === undefined ? {} : { status: status as never });
    for (const row of rows) console.log(`${row.id}\t${row.status}\t${row.tenantId}/${row.bookingNo}\t→ ${row.newStatus}\tattempts=${row.deliveryAttempts}/${row.reconcileAttempts}\t${row.reviewReason ?? row.lastError ?? ""}`);
  } else if (command === "show") {
    const row = await store.get(Number(args[0]));
    show(row === undefined ? "not found" : { row, events: await store.events(row.id) });
  } else if (command === "review") {
    const [tenant, subject, kind, id, ...rest] = args;
    if (!tenant || !subject || !kind || !id) throw new Error("usage: review <tenant> <approver> applied|not-applied|redeliver <outboxId> ...");
    const context = mintSecurityContextForTest({ tenantId: tenant, subject, requestId: `cli-${Date.now()}` });
    const review = new ManualReview(pool, new Policy(new PrincipalDirectory(loadTenantFixture().principals)), systemClock);
    const resolution: Resolution =
      kind === "applied"
        ? { kind: "confirmed_applied", toVersion: Number(rest[0]), note: rest[1] ?? "" }
        : kind === "not-applied"
          ? { kind: "confirmed_not_applied", note: rest[0] ?? "" }
          : { kind: "redeliver", note: rest[0] ?? "", acceptDuplicateRisk: rest.includes("--accept-duplicate-risk") };
    show(await review.resolve(context, Number(id), resolution));
  } else {
    console.error("commands: list [status] | show <id> | review <tenant> <approver> applied|not-applied|redeliver <id> ...");
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
