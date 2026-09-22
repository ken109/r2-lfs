import { describe, expect, it } from "vitest";

import { ConflictError } from "../../cli/app/ports.ts";
import { createToken, listTokens, revoke } from "../../cli/app/token.ts";
import { TOKENS_KEY } from "../../src/shared/contract.ts";
import { MemoryBucket } from "./helpers.ts";

describe("tokens", () => {
  it("creates, lists and revokes without storing the token", async () => {
    const bucket = new MemoryBucket();
    const { token, entry } = await createToken(bucket, { label: "laptop", scope: "acme/*", permission: "write" });
    expect(token).toMatch(/^r2lfs_[\w-]{43}$/);
    expect(bucket.objects.get(TOKENS_KEY)?.body).not.toContain(token);
    expect(await listTokens(bucket)).toEqual([
      { id: entry.id, label: "laptop", scope: "acme/*", permission: "write", created: entry.created },
    ]);
    await revoke(bucket, "laptop");
    expect(await listTokens(bucket)).toEqual([]);
  });

  it("refuses to overwrite tokens another command added in the meantime", async () => {
    const bucket = new MemoryBucket();
    await createToken(bucket, { label: "laptop", scope: "acme/*", permission: "write" });
    const read = bucket.get.bind(bucket);
    const racing = async (key: string) => {
      const current = await read(key);
      await bucket.put(key, JSON.stringify({ version: 1, tokens: [] }));
      bucket.get = read;
      return current;
    };

    bucket.get = racing;
    await expect(createToken(bucket, { label: "ci", scope: "acme/*", permission: "read" })).rejects.toBeInstanceOf(ConflictError);
    await createToken(bucket, { label: "desk", scope: "acme/*", permission: "read" });
    bucket.get = racing;
    await expect(revoke(bucket, "desk")).rejects.toBeInstanceOf(ConflictError);

    const empty = new MemoryBucket();
    empty.get = async (key) => {
      await empty.put(key, JSON.stringify({ version: 1, tokens: [] }));
      return undefined;
    };
    await expect(createToken(empty, { label: "first", scope: "*", permission: "read" })).rejects.toBeInstanceOf(ConflictError);
  });
});
