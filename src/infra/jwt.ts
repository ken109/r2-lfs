import type { Fetcher } from "./github-permissions.ts";

interface Jwk extends JsonWebKey {
  kid?: string;
}

const KEYS_TTL_MS = 10 * 60_000;
/** Allowed clock difference when checking exp and nbf. */
const SKEW_SECONDS = 60;
const keysCache = new Map<string, { keys: Jwk[]; expires: number }>();

export function clearJwtKeysCache(): void {
  keysCache.clear();
}

const decoder = new TextDecoder();

function base64UrlBytes(part: string): Uint8Array {
  const base64 = part
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(part.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function decodePart(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(decoder.decode(base64UrlBytes(part)));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a credential has the shape of a JWT, as opposed to an opaque token. */
export function looksLikeJwt(token: string): boolean {
  return /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(token);
}

async function keysAt(fetcher: Fetcher, url: string, refresh: boolean): Promise<Jwk[]> {
  const hit = keysCache.get(url);
  if (hit && !refresh && hit.expires > Date.now()) return hit.keys;
  const res = await fetcher(url).catch(() => undefined);
  if (!res?.ok) return hit?.keys ?? [];
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  keysCache.set(url, { keys, expires: Date.now() + KEYS_TTL_MS });
  return keys;
}

/**
 * Verifies an RS256 JWT against the signing keys published at `jwksUrl` and checks its issuer, audience and
 * lifetime. Returns the claims, or undefined when any check fails.
 */
export async function verifyJwt(
  fetcher: Fetcher,
  token: string,
  expected: { jwksUrl: string; issuer: string; audience: string },
): Promise<Record<string, unknown> | undefined> {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodePart(headerPart);
  const payload = decodePart(payloadPart);
  if (!header || !payload || header.alg !== "RS256") return undefined;

  // Keys rotate: an unknown key id is looked up again before the token is refused.
  let jwk = (await keysAt(fetcher, expected.jwksUrl, false)).find((k) => k.kid === header.kid);
  jwk ??= (await keysAt(fetcher, expected.jwksUrl, true)).find((k) => k.kid === header.kid);
  if (!jwk) return undefined;

  let signed: boolean;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    signed = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
  } catch {
    return undefined;
  }
  if (!signed) return undefined;

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(expected.audience)) return undefined;
  if (payload.iss !== expected.issuer) return undefined;
  if (typeof payload.exp !== "number" || payload.exp + SKEW_SECONDS < now) return undefined;
  if (typeof payload.nbf === "number" && payload.nbf - SKEW_SECONDS > now) return undefined;
  return payload;
}
