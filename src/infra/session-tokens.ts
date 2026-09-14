import type { SessionClaims, SessionTokens } from "../app/ports.ts";
import { SESSION_KEY_KEY, SESSION_TOKEN_PREFIX } from "../shared/contract.ts";

const KEY_TTL_MS = 5 * 60_000;
// Per isolate. Deleting the key object revokes every token once isolates reload it.
let cached: { key: CryptoKey; expires: number } | undefined;

export function clearSessionKeyCache(): void {
  cached = undefined;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.codePointAt(0)!);
  } catch {
    return undefined;
  }
}

const PERMISSIONS = new Set(["read", "write", "admin"]);

function parseClaims(json: unknown): SessionClaims | undefined {
  const c = json as Record<string, unknown> | null;
  if (typeof c?.r !== "string" || typeof c.p !== "string" || !PERMISSIONS.has(c.p) || typeof c.e !== "number") return undefined;
  return {
    repo: c.r,
    permission: c.p as SessionClaims["permission"],
    expires: c.e,
    ...(typeof c.u === "string" ? { login: c.u } : {}),
    ...(typeof c.o === "string" ? { oid: c.o } : {}),
  };
}

/** HMAC-SHA256 tokens, keyed by a random secret the Worker keeps in the bucket and creates on first use. */
export class HmacSessionTokens implements SessionTokens {
  private readonly bucket: R2Bucket;
  private readonly now: () => number;

  constructor(bucket: R2Bucket, now: () => number = () => Date.now()) {
    this.bucket = bucket;
    this.now = now;
  }

  private async key(): Promise<CryptoKey> {
    if (cached && cached.expires > this.now()) return cached.key;
    let raw = await this.bucket.get(SESSION_KEY_KEY).then((o) => o?.text());
    if (raw === undefined) {
      const fresh = base64url(crypto.getRandomValues(new Uint8Array(32)));
      // Two isolates may race to create it; the loser reads the winner's key.
      const written = await this.bucket.put(SESSION_KEY_KEY, fresh, { onlyIf: new Headers({ "If-None-Match": "*" }) });
      raw = written ? fresh : await this.bucket.get(SESSION_KEY_KEY).then((o) => o?.text());
    }
    const bytes = raw === undefined ? undefined : fromBase64url(raw);
    if (!bytes || bytes.length < 32) throw new Error(`${SESSION_KEY_KEY} is not a base64url key of at least 32 bytes`);
    const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    cached = { key, expires: this.now() + KEY_TTL_MS };
    return key;
  }

  async mint(claims: SessionClaims): Promise<string> {
    const body = {
      r: claims.repo,
      p: claims.permission,
      e: claims.expires,
      ...(claims.login ? { u: claims.login } : {}),
      ...(claims.oid ? { o: claims.oid } : {}),
    };
    const payload = base64url(encoder.encode(JSON.stringify(body)));
    const signature = await crypto.subtle.sign("HMAC", await this.key(), encoder.encode(payload));
    return `${SESSION_TOKEN_PREFIX}${payload}.${base64url(new Uint8Array(signature))}`;
  }

  async verify(token: string): Promise<SessionClaims | undefined> {
    if (!token.startsWith(SESSION_TOKEN_PREFIX)) return undefined;
    const [payload, signature, ...rest] = token.slice(SESSION_TOKEN_PREFIX.length).split(".");
    if (!payload || !signature || rest.length > 0) return undefined;
    const sig = fromBase64url(signature);
    if (!sig) return undefined;
    // crypto.subtle.verify compares in constant time.
    if (!(await crypto.subtle.verify("HMAC", await this.key(), sig, encoder.encode(payload)))) return undefined;
    const bytes = fromBase64url(payload);
    let claims: SessionClaims | undefined;
    try {
      claims = bytes ? parseClaims(JSON.parse(new TextDecoder().decode(bytes))) : undefined;
    } catch {
      return undefined;
    }
    return claims && claims.expires * 1000 > this.now() ? claims : undefined;
  }
}
