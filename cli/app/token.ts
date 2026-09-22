import { mintToken, serializeTokensFile, type StoredToken, TOKENS_KEY } from "../../src/shared/contract.ts";
import { addToken, parseTokensFile, revokeToken } from "../domain/tokens.ts";
import type { Bucket } from "./ports.ts";

async function load(bucket: Bucket) {
  const object = await bucket.get(TOKENS_KEY);
  return { file: parseTokensFile(await object?.text()), etag: object?.etag ?? null };
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
  const { token, id, sha256 } = await mintToken();
  const { file: next, entry } = addToken(file, { ...input, id, sha256, created: new Date() });
  // Conditional on the version read, so concurrent edits cannot drop each other's tokens.
  await bucket.put(TOKENS_KEY, serializeTokensFile(next), { expectEtag: etag });
  return { token, entry };
}

export async function revoke(bucket: Bucket, idOrLabel: string): Promise<StoredToken> {
  const { file, etag } = await load(bucket);
  const { file: next, entry } = revokeToken(file, idOrLabel);
  await bucket.put(TOKENS_KEY, serializeTokensFile(next), { expectEtag: etag });
  return entry;
}
