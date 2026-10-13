import { errors, jwtVerify, type CryptoKey } from "jose";

import type { PrincipalDirectory } from "./directory.js";
import { mintSecurityContext, type SecurityContext } from "./security-context.js";

/**
 * Why authentication failed. These reasons exist for the server-side log and for tests. They are
 * never sent to the client: every reason maps to the same 401 body (see `http-server.ts`), so a
 * caller cannot use the response to learn whether a token had the right signature, tenant, or
 * subject.
 */
export type AuthFailureReason =
  | "missing_token"
  | "malformed_authorization"
  | "invalid_token"
  | "expired"
  | "wrong_audience"
  | "wrong_issuer"
  | "missing_claim"
  | "unknown_principal";

export type AuthResult =
  | { ok: true; context: SecurityContext }
  | { ok: false; reason: AuthFailureReason };

export interface AuthenticatorOptions {
  issuer: string;
  audience: string;
  publicKey: CryptoKey;
  directory: PrincipalDirectory;
  /** Injectable clock for expiry tests. */
  now?: () => Date;
}

/** Only the `Authorization` header is read. `X-Tenant-Id` and friends are never consulted. */
export interface AuthHeaders {
  authorization?: string | string[] | undefined;
}

function bearerToken(header: string | string[] | undefined): { token: string } | { reason: AuthFailureReason } {
  if (header === undefined) return { reason: "missing_token" };
  if (Array.isArray(header)) return { reason: "malformed_authorization" };
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ? { token: match[1] } : { reason: "malformed_authorization" };
}

function reasonFor(error: unknown): AuthFailureReason {
  if (error instanceof errors.JWTExpired) return "expired";
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "aud") return "wrong_audience";
    if (error.claim === "iss") return "wrong_issuer";
    return "missing_claim";
  }
  return "invalid_token";
}

/**
 * Validates identity with `jose` — signature, issuer, audience, expiry — pinned to one signing
 * algorithm so `alg: none` and algorithm-confusion tokens are rejected before any claim is read.
 * Tenant and subject then come only from the verified payload and must name a principal the
 * server-side directory knows. The returned `SecurityContext` is the sole source of identity for
 * the rest of the request.
 *
 * `requestId` is supplied by the caller (the server generates it); this function does not read a
 * client-provided one.
 */
export function createAuthenticator(options: AuthenticatorOptions) {
  return async function authenticate(headers: AuthHeaders, requestId: string): Promise<AuthResult> {
    const bearer = bearerToken(headers.authorization);
    if ("reason" in bearer) return { ok: false, reason: bearer.reason };

    let payload;
    try {
      ({ payload } = await jwtVerify(bearer.token, options.publicKey, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ["ES256"],
        requiredClaims: ["sub", "exp", "tid"],
        currentDate: options.now?.(),
      }));
    } catch (error) {
      return { ok: false, reason: reasonFor(error) };
    }

    const tenantId = payload.tid;
    const subject = payload.sub;
    if (typeof tenantId !== "string" || typeof subject !== "string" || tenantId === "" || subject === "") {
      return { ok: false, reason: "missing_claim" };
    }
    if (!options.directory.has(tenantId, subject)) {
      return { ok: false, reason: "unknown_principal" };
    }

    return { ok: true, context: mintSecurityContext({ tenantId, subject, authSource: "local-test-token", requestId }) };
  };
}

export type Authenticate = ReturnType<typeof createAuthenticator>;
