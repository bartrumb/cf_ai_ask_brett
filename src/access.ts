/*
 * Verifies Cloudflare Access identity tokens at the Worker. Access protects the route at the edge,
 * and this check confirms that a request really passed through the expected Access application.
 */
import { z } from "zod";

/** How long fetched signing keys are reused within one isolate. */
const KEY_CACHE_MS = 10 * 60 * 1000;

const jwtHeaderSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(200) });
const jwtPayloadSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]),
  iss: z.string(),
  exp: z.number(),
  nbf: z.number().optional(),
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

let cachedKeys: { teamDomain: string; expires: number; keys: z.infer<typeof certificatesSchema>["keys"] } | null = null;

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

/** Loads the team's public signing keys, using the short-lived cache when possible. */
async function loadKeys(teamDomain: string, fetcher: typeof fetch) {
  if (cachedKeys?.teamDomain === teamDomain && cachedKeys.expires > Date.now()) return cachedKeys.keys;
  const response = await fetcher(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("Access signing keys are unavailable.");
  const { keys } = certificatesSchema.parse(await response.json());
  cachedKeys = { teamDomain, keys, expires: Date.now() + KEY_CACHE_MS };
  return keys;
}

/**
 * Checks signature, issuer, audience and time limits.
 *
 * @returns True only for a currently valid token. Malformed tokens and key failures return false,
 * so every failure denies access.
 */
export async function verifyAccessToken(token: string | null, config: AccessConfig, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!token || token.length > 8_192) return false;
  try {
    const teamDomain = teamDomainSchema.parse(config.teamDomain);
    const [rawHeader, rawPayload, rawSignature, extra] = token.split(".");
    if (!rawHeader || !rawPayload || !rawSignature || extra !== undefined) return false;
    const header = jwtHeaderSchema.parse(decodeJson(rawHeader));
    const payload = jwtPayloadSchema.parse(decodeJson(rawPayload));

    const now = Date.now() / 1000;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.exp <= now || (payload.nbf ?? 0) > now + 60) return false;
    if (payload.iss !== `https://${teamDomain}.cloudflareaccess.com` || !audiences.includes(config.audience)) return false;

    const jwk = (await loadKeys(teamDomain, fetcher)).find((key) => key.kid === header.kid);
    if (!jwk) return false;
    const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, algorithm, false, ["verify"]);
    const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
    return await crypto.subtle.verify(algorithm, key, decodeSegment(rawSignature), signed);
  } catch {
    return false;
  }
}
