import type { AccessVerifier } from "../app/ports.ts";
import type { AccessSettings } from "../domain/config.ts";
import type { Fetcher } from "./github-permissions.ts";

interface Jwk extends JsonWebKey {
  kid?: string;
}

const KEYS_TTL_MS = 10 * 60_000;
/** Allowed clock difference when checking exp and nbf. */
const SKEW_SECONDS = 60;
const keysCache = new Map<string, { keys: Jwk[]; expires: number }>();

export function clearAccessKeysCache(): void {
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

/** Verifies the RS256 tokens Cloudflare Access issues, against the team's published signing keys. */
export class AccessJwtVerifier implements AccessVerifier {
  private readonly fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    this.fetcher = fetcher;
  }

  private async keys(teamDomain: string, refresh: boolean): Promise<Jwk[]> {
    const hit = keysCache.get(teamDomain);
    if (hit && !refresh && hit.expires > Date.now()) return hit.keys;
    const res = await this.fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) return hit?.keys ?? [];
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = Array.isArray(body.keys) ? body.keys : [];
    keysCache.set(teamDomain, { keys, expires: Date.now() + KEYS_TTL_MS });
    return keys;
  }

  async verify(token: string, settings: AccessSettings): Promise<string | undefined> {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodePart(headerPart);
    const payload = decodePart(payloadPart);
    if (!header || !payload || header.alg !== "RS256") return undefined;

    // Keys rotate: an unknown key id is looked up again before the token is refused.
    let jwk = (await this.keys(settings.teamDomain, false)).find((k) => k.kid === header.kid);
    jwk ??= (await this.keys(settings.teamDomain, true)).find((k) => k.kid === header.kid);
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
    if (!audiences.includes(settings.aud)) return undefined;
    if (payload.iss !== `https://${settings.teamDomain}`) return undefined;
    if (typeof payload.exp !== "number" || payload.exp + SKEW_SECONDS < now) return undefined;
    if (typeof payload.nbf === "number" && payload.nbf - SKEW_SECONDS > now) return undefined;
    return typeof payload.email === "string" ? payload.email : typeof payload.sub === "string" ? payload.sub : undefined;
  }
}
