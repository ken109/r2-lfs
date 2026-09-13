import type { TokenDirectory } from "../app/ports.ts";
import type { Grant } from "../domain/access.ts";
import type { StaticToken } from "../domain/config.ts";
import { type StoredToken, storedTokensIn, TOKENS_KEY } from "../shared/contract.ts";
import { secretEquals, sha256Hex } from "./crypto.ts";

const TTL_MS = 30_000;
let cache: { bucket: R2Bucket; tokens: StoredToken[]; expires: number } | undefined;

export function clearStoredTokensCache(): void {
  cache = undefined;
}

/** Revocations take effect once the cached copy expires, within 30 seconds. */
async function storedTokens(bucket: R2Bucket): Promise<StoredToken[]> {
  if (cache && cache.bucket === bucket && cache.expires > Date.now()) return cache.tokens;
  const object = await bucket.get(TOKENS_KEY);
  let tokens: StoredToken[] = [];
  if (object) {
    const parsed = storedTokensIn(await object.json().catch(() => undefined));
    // A broken file must not take down tokens from AUTH_TOKENS as well.
    if (parsed) tokens = parsed;
    else console.error(`${TOKENS_KEY} is not a valid tokens file; ignoring stored tokens`);
  }
  cache = { bucket, tokens, expires: Date.now() + TTL_MS };
  return tokens;
}

/** Tokens from the AUTH_TOKENS secret plus those `r2-lfs token` keeps in the bucket. */
export class CombinedTokenDirectory implements TokenDirectory {
  private readonly staticTokens: readonly StaticToken[];
  private readonly bucket: R2Bucket;

  constructor(staticTokens: readonly StaticToken[], bucket: R2Bucket) {
    this.staticTokens = staticTokens;
    this.bucket = bucket;
  }

  async grantsFor(token: string): Promise<Grant[]> {
    const tokenHash = await sha256Hex(token);
    const candidates = [
      ...this.staticTokens.map((t) => ({ grant: t, matches: secretEquals(t.token, token) })),
      ...(await storedTokens(this.bucket)).map((t) => ({ grant: t, matches: secretEquals(t.sha256, tokenHash) })),
    ];
    // Every candidate is compared, so timing does not reveal how many tokens exist or which matched.
    const results = await Promise.all(candidates.map((c) => c.matches));
    return candidates.filter((_, i) => results[i]).map(({ grant }) => ({ scope: grant.scope, permission: grant.permission }));
  }
}
