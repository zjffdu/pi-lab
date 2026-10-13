import { ISSUER_KEYS_PATH } from "../src/app.js";
import { loadOrCreateIssuerKeys, signTestToken } from "../src/token-issuer.js";

/**
 * Prints one signed local test token to stdout (nothing else), for use as
 * `Authorization: Bearer $(npm run --silent token -- tenant-a bob)`. The token is signed with the
 * throwaway key in runtime-evidence/ and only works against this lab's local server.
 */
const [tenant, subject] = process.argv.slice(2);
if (!tenant || !subject) {
  console.error("Usage: npm run --silent token -- <tenantId> <subject>");
  process.exit(1);
}
const keys = await loadOrCreateIssuerKeys(ISSUER_KEYS_PATH);
process.stdout.write(await signTestToken(keys.privateKey, { tid: tenant, sub: subject }));
