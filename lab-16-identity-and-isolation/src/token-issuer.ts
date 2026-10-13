import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { SignJWT, exportJWK, generateKeyPair, importJWK, type CryptoKey, type JWK } from "jose";

export const LOCAL_ISSUER = "https://issuer.pi-lab.local";
export const LOCAL_AUDIENCE = "api://pi-lab-16";
const ALGORITHM = "ES256";

export interface IssuerKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export async function generateIssuerKeys(): Promise<IssuerKeys> {
  const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { extractable: true });
  return { privateKey, publicKey };
}

interface StoredKeys {
  privateJwk: JWK;
  publicJwk: JWK;
}

/**
 * Persists a local test key pair so `npm run token` and `npm run dev` (separate processes) agree
 * on one issuer. The file lives in the ignored `runtime-evidence/` directory and holds a
 * throwaway test key that signs tokens for synthetic data only; it is never a production secret.
 */
export async function loadOrCreateIssuerKeys(path: string): Promise<IssuerKeys> {
  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as StoredKeys;
    return {
      privateKey: (await importJWK(stored.privateJwk, ALGORITHM)) as CryptoKey,
      publicKey: (await importJWK(stored.publicJwk, ALGORITHM)) as CryptoKey,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const keys = await generateIssuerKeys();
  const stored: StoredKeys = {
    privateJwk: await exportJWK(keys.privateKey),
    publicJwk: await exportJWK(keys.publicKey),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
  return keys;
}

export interface TokenSpec {
  /** Subject claim (`sub`). Omit to produce a token with no subject. */
  sub?: string;
  /** Tenant claim (`tid`). Omit to produce a token with no tenant. */
  tid?: string;
  issuer?: string;
  audience?: string;
  /** Seconds from `now` until expiry; negative produces an already-expired token. Default 300. */
  expiresInSeconds?: number;
  /** Reference time for `iat`/`exp`. Default: the real clock. */
  now?: Date;
}

/** Signs a test token. Every default is the valid one, so a test overrides exactly one thing. */
export async function signTestToken(privateKey: CryptoKey, spec: TokenSpec = {}): Promise<string> {
  const nowSeconds = Math.floor((spec.now ?? new Date()).getTime() / 1000);
  const claims: Record<string, unknown> = {};
  if (spec.tid !== undefined) claims.tid = spec.tid;

  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuer(spec.issuer ?? LOCAL_ISSUER)
    .setAudience(spec.audience ?? LOCAL_AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + (spec.expiresInSeconds ?? 300));
  if (spec.sub !== undefined) jwt = jwt.setSubject(spec.sub);
  return jwt.sign(privateKey);
}
