import { createHash, randomBytes } from "node:crypto";

import { type StoredToken, TOKENS_KEY } from "../../src/shared/contract.ts";
import { addToken, emptyTokensFile, parseTokensFile, revokeToken } from "../domain/tokens.ts";
import type { Bucket } from "./ports.ts";

async function load(bucket: Bucket) {
  const object = await bucket.get(TOKENS_KEY);
  if (!object) return { file: emptyTokensFile(), etag: null };
  return { file: parseTokensFile(await object.text()), etag: object.etag };
}

export async function listTokens(bucket: Bucket): Promise<Omit<StoredToken, "sha256">[]> {
  const { file } = await load(bucket);
  return file.tokens.map(({ sha256: _hash, ...rest }) => rest);
}

export async function createToken(
  bucket: Bucket,
  input: { label: string; scope: string; permission: StoredToken["permission"] },
): Promise<{ token: string; entry: StoredToken }> {
  const { file, etag } = await load(bucket);
  const token = `r2lfs_${randomBytes(32).toString("base64url")}`;
  const { file: next, entry } = addToken(file, {
    ...input,
    id: randomBytes(4).toString("hex"),
    sha256: createHash("sha256").update(token).digest("hex"),
    created: new Date(),
  });
  // Conditional on the version read, so concurrent edits cannot drop each other's tokens.
  await bucket.put(TOKENS_KEY, `${JSON.stringify(next, null, 2)}\n`, { expectEtag: etag });
  return { token, entry };
}

export async function revoke(bucket: Bucket, idOrLabel: string): Promise<StoredToken> {
  const { file, etag } = await load(bucket);
  const { file: next, entry } = revokeToken(file, idOrLabel);
  await bucket.put(TOKENS_KEY, `${JSON.stringify(next, null, 2)}\n`, { expectEtag: etag });
  return entry;
}
