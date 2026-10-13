import { SignJWT, generateKeyPair, type CryptoKey } from "jose";

import { assertSecurityContext, type SecurityContext } from "./security-context.js";

export const DELEGATION_ISSUER = "https://issuer.pi-lab.local";
export const DOWNSTREAM_AUDIENCE = "api://pi-lab-17-bookings";
/** The `act.sub` the downstream requires: the token was obtained *by the assistant, on behalf of* `sub`. */
export const ASSISTANT_CLIENT_ID = "pi-lab-assistant";
export const SCOPE_READ = "bookings.read";
export const SCOPE_WRITE = "bookings.write";
export const DELEGATION_ALGORITHM = "ES256";

export interface DelegatedTokenRequest {
  audience: string;
  scopes: readonly string[];
}

/**
 * The seam between the application and whatever obtains a credential for a downstream API on a
 * user's behalf. The caller supplies a `SecurityContext` — the trusted principal — and says what
 * it wants (audience, scopes); it gets back an opaque bearer string. Only a connector calls this,
 * and the string goes straight into an HTTP header: it is never returned to a tool, stored in a
 * session, audit record, or log, and the model never sees it.
 *
 * `LocalDelegatedTokenProvider` below is a local stand-in. It is *not* an on-behalf-of exchange
 * with a real identity provider; see README, "What this does not establish".
 */
export interface DelegatedTokenProvider {
  acquire(context: SecurityContext, request: DelegatedTokenRequest): Promise<string>;
}

export interface LocalDelegatedTokenProviderOptions {
  privateKey: CryptoKey;
  /**
   * Scopes the (simulated) user has consented to for the assistant. A request for a scope
   * outside this set is silently narrowed — the token comes back without it, as an OAuth server
   * commonly does — so an under-scoped token is a downstream-visible condition, not an exception.
   */
  consentedScopes: readonly string[];
  /** Test switch: issue a plain user token with no `act` claim (no delegation). */
  omitActor?: boolean;
  /** Seconds until expiry; negative produces an already-expired token. Default 60. */
  expiresInSeconds?: number;
  now?: () => Date;
}

export class LocalDelegatedTokenProvider implements DelegatedTokenProvider {
  public constructor(private readonly options: LocalDelegatedTokenProviderOptions) {}

  public async acquire(context: SecurityContext, request: DelegatedTokenRequest): Promise<string> {
    assertSecurityContext(context);
    const nowSeconds = Math.floor((this.options.now?.() ?? new Date()).getTime() / 1000);
    const granted = request.scopes.filter((scope) => this.options.consentedScopes.includes(scope));

    const claims: Record<string, unknown> = { tid: context.tenantId, scope: granted.join(" ") };
    if (!this.options.omitActor) claims.act = { sub: ASSISTANT_CLIENT_ID };

    return new SignJWT(claims)
      .setProtectedHeader({ alg: DELEGATION_ALGORITHM })
      .setIssuer(DELEGATION_ISSUER)
      .setAudience(request.audience)
      .setSubject(context.subject)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + (this.options.expiresInSeconds ?? 60))
      .sign(this.options.privateKey);
  }
}

export async function generateDelegationKeys(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const { privateKey, publicKey } = await generateKeyPair(DELEGATION_ALGORITHM);
  return { privateKey, publicKey };
}
