/*
 * Verifies Cloudflare Access identity tokens at the Worker. Access protects the route at the edge,
 * and this check confirms that a request really passed through the expected Access application.
 */
import { z } from "zod";

/** How long fetched signing keys are reused within one isolate. */
const KEY_CACHE_MS = 10 * 60 * 1000;
/** How long a failed key download is remembered, so an outage cannot multiply requests. */
const KEY_FAILURE_CACHE_MS = 30 * 1000;
/** Minimum key age before an unknown key ID may trigger one refresh. */
const KEY_REFRESH_MIN_AGE_MS = 60 * 1000;

/** Set by the Worker for the agent. Client-supplied values are always removed first. */
export const ACCESS_EXPIRES_HEADER = "x-ask-brett-access-expires";
/** Carries the Worker's hashed daily visitor key to the agent. */
export const CLIENT_KEY_HEADER = "x-ask-brett-client";

const jwtHeaderSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(200) });
const jwtPayloadSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]),
  iss: z.string(),
  exp: z.number(),
  nbf: z.number().optional(),
  email: z.email().max(254).optional(),
});
const certificatesSchema = z.object({
  keys: z.array(z.looseObject({ kid: z.string(), kty: z.literal("RSA") })).max(20),
});
/** Team names become part of a fetched URL, so only a plain hostname label is accepted. */
const teamDomainSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

/** The Access application a token must belong to. */
export interface AccessConfig {
  teamDomain: string;
  audience: string;
}

/** Verified facts from an Access token. */
export interface AccessIdentity {
  /** Token expiry in Unix seconds. */
  expiresAt: number;
  email: string | null;
}

type SigningKeys = z.infer<typeof certificatesSchema>["keys"];
let cachedKeys: { teamDomain: string; fetchedAt: number; expires: number; keys: SigningKeys | null } | null = null;

/** Clears cached signing keys. Tests use this between key pairs. */
export function resetAccessKeyCache(): void {
  cachedKeys = null;
}

/** Decodes one base64url JWT segment to bytes. */
function decodeSegment(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (character) => character.charCodeAt(0));
}

/** Decodes a JWT JSON segment. */
function decodeJson(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeSegment(segment)));
}

/** Downloads signing keys and remembers either the keys or the failure. */
async function fetchKeys(teamDomain: string, fetcher: typeof fetch): Promise<SigningKeys> {
  const now = Date.now();
  try {
    const response = await fetcher(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
    if (!response.ok) throw new Error("Access signing keys are unavailable.");
    const { keys } = certificatesSchema.parse(await response.json());
    cachedKeys = { teamDomain, keys, fetchedAt: now, expires: now + KEY_CACHE_MS };
    return keys;
  } catch (error) {
    cachedKeys = { teamDomain, keys: null, fetchedAt: now, expires: now + KEY_FAILURE_CACHE_MS };
    throw error;
  }
}

/**
 * Finds a signing key. An unknown ID causes at most one refresh per minute, so rotated keys work
 * quickly while made-up IDs cannot force repeated downloads.
 */
async function findKey(teamDomain: string, kid: string, fetcher: typeof fetch) {
  const cached = cachedKeys?.teamDomain === teamDomain && cachedKeys.expires > Date.now() ? cachedKeys : null;
  if (cached && !cached.keys) throw new Error("Access signing keys are unavailable.");
  const keys = cached?.keys ?? (await fetchKeys(teamDomain, fetcher));
  const key = keys.find((item) => item.kid === kid);
  if (key || !cached || Date.now() - cached.fetchedAt < KEY_REFRESH_MIN_AGE_MS) return key;
  return (await fetchKeys(teamDomain, fetcher)).find((item) => item.kid === kid);
}

/**
 * Checks signature, issuer, audience and time limits.
 *
 * @returns The verified identity, or null for any invalid token or key failure, so every failure
 * denies access.
 */
export async function verifyAccessToken(token: string | null, config: AccessConfig, fetcher: typeof fetch = fetch): Promise<AccessIdentity | null> {
  if (!token || token.length > 8_192) return null;
  try {
    const teamDomain = teamDomainSchema.parse(config.teamDomain);
    const [rawHeader, rawPayload, rawSignature, extra] = token.split(".");
    if (!rawHeader || !rawPayload || !rawSignature || extra !== undefined) return null;
    const header = jwtHeaderSchema.parse(decodeJson(rawHeader));
    const payload = jwtPayloadSchema.parse(decodeJson(rawPayload));

    const now = Date.now() / 1000;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.exp <= now || (payload.nbf ?? 0) > now + 60) return null;
    if (payload.iss !== `https://${teamDomain}.cloudflareaccess.com` || !audiences.includes(config.audience)) return null;

    const jwk = await findKey(teamDomain, header.kid, fetcher);
    if (!jwk) return null;
    const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, algorithm, false, ["verify"]);
    const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
    const valid = await crypto.subtle.verify(algorithm, key, decodeSegment(rawSignature), signed);
    return valid ? { expiresAt: payload.exp, email: payload.email ?? null } : null;
  } catch {
    return null;
  }
}
