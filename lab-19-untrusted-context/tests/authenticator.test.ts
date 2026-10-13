import { SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuthenticator, type AuthResult } from "../src/authenticator.js";
import { PrincipalDirectory, loadTenantFixture } from "../src/directory.js";
import { LOCAL_AUDIENCE, LOCAL_ISSUER, generateIssuerKeys, signTestToken, type IssuerKeys } from "../src/token-issuer.js";

/**
 * Deterministic, network-free proof of the identity boundary. Each failure injection from the
 * roadmap is one row: the token is valid in every respect except the one named.
 */
let keys: IssuerKeys;
let attackerKeys: IssuerKeys;
let authenticate: ReturnType<typeof createAuthenticator>;

beforeAll(async () => {
  keys = await generateIssuerKeys();
  attackerKeys = await generateIssuerKeys();
  authenticate = createAuthenticator({
    issuer: LOCAL_ISSUER,
    audience: LOCAL_AUDIENCE,
    publicKey: keys.publicKey,
    directory: new PrincipalDirectory(loadTenantFixture().principals),
  });
});

const withBearer = (token: string) => ({ authorization: `Bearer ${token}` });
const reasonOf = (result: AuthResult) => (result.ok ? "ok" : result.reason);

describe("authenticate — valid identity", () => {
  it("builds a SecurityContext from verified claims and the server-supplied request ID", async () => {
    const token = await signTestToken(keys.privateKey, { tid: "tenant-a", sub: "alice" });
    const result = await authenticate(withBearer(token), "req-123");
    expect(result).toMatchObject({
      ok: true,
      context: { tenantId: "tenant-a", subject: "alice", authSource: "local-test-token", requestId: "req-123" },
    });
  });

  it("ignores self-reported tenant/user headers: identity comes from the token alone", async () => {
    const token = await signTestToken(keys.privateKey, { tid: "tenant-a", sub: "alice" });
    const forged = { authorization: `Bearer ${token}`, "x-tenant-id": "tenant-b", "x-user-id": "carol" };
    const result = await authenticate(forged, "req-1");
    expect(result).toMatchObject({ ok: true, context: { tenantId: "tenant-a", subject: "alice" } });
  });

  it("does not authenticate a forged tenant header without a token", async () => {
    const result = await authenticate({ "x-tenant-id": "tenant-b" } as never, "req-1");
    expect(reasonOf(result)).toBe("missing_token");
  });
});

describe("authenticate — invalid identity is rejected with a distinct server-side reason", () => {
  it("expired token", async () => {
    const token = await signTestToken(keys.privateKey, { tid: "tenant-a", sub: "alice", expiresInSeconds: -60 });
    expect(reasonOf(await authenticate(withBearer(token), "r"))).toBe("expired");
  });

  it("wrong audience", async () => {
    const token = await signTestToken(keys.privateKey, { tid: "tenant-a", sub: "alice", audience: "api://someone-else" });
    expect(reasonOf(await authenticate(withBearer(token), "r"))).toBe("wrong_audience");
  });

  it("wrong issuer", async () => {
    const token = await signTestToken(keys.privateKey, { tid: "tenant-a", sub: "alice", issuer: "https://evil.example" });
    expect(reasonOf(await authenticate(withBearer(token), "r"))).toBe("wrong_issuer");
  });

  it("valid-looking token signed by a different key", async () => {
    const token = await signTestToken(attackerKeys.privateKey, { tid: "tenant-a", sub: "alice" });
    expect(reasonOf(await authenticate(withBearer(token), "r"))).toBe("invalid_token");
  });

  it("unsigned token (alg: none)", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({ iss: LOCAL_ISSUER, aud: LOCAL_AUDIENCE, sub: "alice", tid: "tenant-a", exp: now + 300 })}.`;
    expect(reasonOf(await authenticate(withBearer(unsigned), "r"))).toBe("invalid_token");
  });

  it("token signed with a different algorithm than the pinned one", async () => {
    const hmac = await new SignJWT({ tid: "tenant-a" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(LOCAL_ISSUER)
      .setAudience(LOCAL_AUDIENCE)
      .setSubject("alice")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("a-shared-secret-that-is-long-enough-32b"));
    expect(reasonOf(await authenticate(withBearer(hmac), "r"))).toBe("invalid_token");
  });

  it("missing tenant claim", async () => {
    const token = await signTestToken(keys.privateKey, { sub: "alice" });
    expect(reasonOf(await authenticate(withBearer(token), "r"))).toBe("missing_claim");
  });

  it("missing subject claim", async () => {
    const token = await signTestToken(keys.privateKey, { tid: "tenant-a" });
    expect(reasonOf(await authenticate(withBearer(token), "r"))).toBe("missing_claim");
  });

  it("validly signed token naming a principal the directory does not know", async () => {
    const token = await signTestToken(keys.privateKey, { tid: "tenant-a", sub: "mallory" });
    expect(reasonOf(await authenticate(withBearer(token), "r"))).toBe("unknown_principal");
  });

  it("validly signed token pairing a real subject with the wrong tenant", async () => {
    const token = await signTestToken(keys.privateKey, { tid: "tenant-b", sub: "alice" });
    expect(reasonOf(await authenticate(withBearer(token), "r"))).toBe("unknown_principal");
  });

  it("no Authorization header", async () => {
    expect(reasonOf(await authenticate({}, "r"))).toBe("missing_token");
  });

  it("non-Bearer or malformed Authorization header", async () => {
    expect(reasonOf(await authenticate({ authorization: "Basic abc" }, "r"))).toBe("malformed_authorization");
    expect(reasonOf(await authenticate({ authorization: "Bearer" }, "r"))).toBe("malformed_authorization");
    expect(reasonOf(await authenticate({ authorization: ["Bearer a", "Bearer b"] }, "r"))).toBe("malformed_authorization");
  });

  it("uses the injected clock for expiry", async () => {
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const token = await signTestToken(keys.privateKey, { tid: "tenant-a", sub: "alice", now: issuedAt, expiresInSeconds: 60 });
    const clocked = (now: Date) =>
      createAuthenticator({
        issuer: LOCAL_ISSUER,
        audience: LOCAL_AUDIENCE,
        publicKey: keys.publicKey,
        directory: new PrincipalDirectory(loadTenantFixture().principals),
        now: () => now,
      });
    expect(reasonOf(await clocked(new Date("2026-01-01T00:00:30Z"))(withBearer(token), "r"))).toBe("ok");
    expect(reasonOf(await clocked(new Date("2026-01-01T00:02:00Z"))(withBearer(token), "r"))).toBe("expired");
  });
});
