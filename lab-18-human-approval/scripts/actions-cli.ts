import { ISSUER_KEYS_PATH } from "../src/app.js";
import { loadOrCreateIssuerKeys, signTestToken } from "../src/token-issuer.js";

/**
 * A small client for the running dev server (`npm run dev`), acting as one principal.
 *
 *   npm run --silent actions -- tenant-a alice chat "Put BK1001 on hold because of a customs hold"
 *   npm run --silent actions -- tenant-a bob   list [state]
 *   npm run --silent actions -- tenant-a bob   show <id>
 *   npm run --silent actions -- tenant-a bob   approve <id>     # fetches the digest, then approves that exact one
 *   npm run --silent actions -- tenant-a bob   reject|revoke <id>
 *   npm run --silent actions -- tenant-a alice execute <id>
 *
 * `approve` shows the action first and approves the digest it just read, which is what a real
 * approval screen would do: the approver confirms the exact action displayed.
 */
const [tenant, subject, command, argument, ...rest] = process.argv.slice(2);
const base = process.env.LAB18_URL ?? `http://localhost:${process.env.PORT ?? 3980}`;

if (!tenant || !subject || !command) {
  console.error("Usage: npm run --silent actions -- <tenant> <subject> <chat|list|show|approve|reject|revoke|execute> [arg]");
  process.exit(1);
}

const keys = await loadOrCreateIssuerKeys(ISSUER_KEYS_PATH);
const token = await signTestToken(keys.privateKey, { tid: tenant, sub: subject });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function need(value: string | undefined, what: string): string {
  if (!value) {
    console.error(`Missing ${what}.`);
    process.exit(1);
  }
  return value;
}

let result: { status: number; body: unknown };
switch (command) {
  case "chat":
    result = await call("POST", "/v1/chat", { message: [need(argument, "message"), ...rest].join(" ") });
    break;
  case "list":
    result = await call("GET", `/v1/actions${argument ? `?state=${encodeURIComponent(argument)}` : ""}`);
    break;
  case "show":
    result = await call("GET", `/v1/actions/${need(argument, "action id")}`);
    break;
  case "approve": {
    const id = need(argument, "action id");
    const shown = await call("GET", `/v1/actions/${id}`);
    const digest = (shown.body as { action?: { digest?: string } }).action?.digest;
    result = digest ? await call("POST", `/v1/actions/${id}/approve`, { digest }) : shown;
    break;
  }
  case "reject":
  case "revoke":
  case "execute":
    result = await call("POST", `/v1/actions/${need(argument, "action id")}/${command}`, {});
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
console.log(`HTTP ${result.status}`);
console.log(JSON.stringify(result.body, null, 2));
