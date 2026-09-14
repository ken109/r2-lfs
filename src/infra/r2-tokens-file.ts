import type { TokenMinter, TokensFileStore } from "../app/ports.ts";
import { TOKENS_KEY, type TokensFile } from "../shared/contract.ts";
import { sha256Hex, toHex } from "./crypto.ts";
import { clearStoredTokensCache } from "./token-directory.ts";

export class R2TokensFile implements TokensFileStore {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async read() {
    const object = await this.bucket.get(TOKENS_KEY);
    if (!object) return { value: undefined, etag: null };
    return { value: await object.json().catch(() => undefined), etag: object.etag };
  }

  async write(file: TokensFile, etag: string | null) {
    // R2 answers a failed precondition with null instead of an object.
    const onlyIf = etag === null ? new Headers({ "If-None-Match": "*" }) : { etagMatches: etag };
    const written = await this.bucket.put(TOKENS_KEY, `${JSON.stringify(file, null, 2)}\n`, { onlyIf });
    // This isolate sees the change at once; others within the token cache's lifetime.
    if (written) clearStoredTokensCache();
    return written !== null;
  }
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Tokens in the format `r2-lfs token create` makes. */
export class RandomTokenMinter implements TokenMinter {
  async mint() {
    const token = `r2lfs_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
    const id = toHex(crypto.getRandomValues(new Uint8Array(4)).buffer);
    return { token, id, sha256: await sha256Hex(token) };
  }
}
