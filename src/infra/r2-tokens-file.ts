import type { TokenMinter, TokensFileStore } from "../app/ports.ts";
import { mintToken, serializeTokensFile, TOKENS_KEY, type TokensFile } from "../shared/contract.ts";
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
    const written = await this.bucket.put(TOKENS_KEY, serializeTokensFile(file), { onlyIf });
    // This isolate sees the change at once; others within the token cache's lifetime.
    if (written) clearStoredTokensCache();
    return written !== null;
  }
}

/** Tokens in the format `r2-lfs token create` makes. */
export class RandomTokenMinter implements TokenMinter {
  mint() {
    return mintToken();
  }
}
