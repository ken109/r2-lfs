import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/domain/config.ts";
import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";
import { R2ObjectStore } from "../../src/infra/r2-object-store.ts";

const KEY_HEX = "0f".repeat(32);
const KEY_BASE64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x0f)));

const makeEnv = (over: Partial<Env> = {}): Env => ({
  BUCKET: env.BUCKET,
  LOCKS: env.LOCKS,
  ALLOWED_REPOS: "acme/*",
  AUTH_MODE: "token",
  ...over,
});

/** A bucket that records the options each call receives; local R2 does not implement SSE-C. */
function recordingBucket(encrypted: Set<string>) {
  const calls: { method: string; key: string; options: unknown }[] = [];
  const bucket = {
    head: async (key: string) => {
      calls.push({ method: "head", key, options: undefined });
      return { size: 6, ssecKeyMd5: encrypted.has(key) ? "md5" : undefined };
    },
    get: async (key: string, options: unknown) => {
      calls.push({ method: "get", key, options });
      return { body: new Response("secret").body, size: 6 };
    },
    put: async (key: string, _body: unknown, options: unknown) => {
      calls.push({ method: "put", key, options });
      return {};
    },
  } as unknown as R2Bucket;
  return { bucket, calls };
}

describe("encryption at rest", () => {
  it("writes with the SSE-C key, and reads encrypted objects with it and older plain ones without", async () => {
    const { bucket, calls } = recordingBucket(new Set(["acme/app/encrypted"]));
    const store = new R2ObjectStore(bucket, KEY_HEX);
    await store.put("acme/app/new", new Response("x").body!, "a".repeat(64));
    await store.get("acme/app/encrypted");
    await store.get("acme/app/plain");
    expect(calls.filter((c) => c.method !== "head")).toEqual([
      { method: "put", key: "acme/app/new", options: { sha256: "a".repeat(64), ssecKey: KEY_HEX } },
      { method: "get", key: "acme/app/encrypted", options: { ssecKey: KEY_HEX } },
      { method: "get", key: "acme/app/plain", options: {} },
    ]);
  });

  it("accepts the key as hex or base64, never echoes a bad one, and keeps transfers on the Worker", async () => {
    expect(parseConfig(makeEnv({ ENCRYPTION_KEY: KEY_BASE64 })).encryptionKey).toBe(KEY_HEX);
    expect(parseConfig(makeEnv({ ENCRYPTION_KEY: KEY_HEX.toUpperCase() })).encryptionKey).toBe(KEY_HEX);
    let message = "";
    try {
      parseConfig(makeEnv({ ENCRYPTION_KEY: "too-short-secret" }));
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain("ENCRYPTION_KEY must be 32 bytes");
    expect(message).not.toContain("too-short-secret");

    const credentials = { R2_ACCOUNT_ID: "a", R2_BUCKET_NAME: "b", R2_ACCESS_KEY_ID: "c", R2_SECRET_ACCESS_KEY: "d" };
    expect(parseConfig(makeEnv({ ENCRYPTION_KEY: KEY_HEX, ...credentials })).presign).toBeUndefined();
    expect(() => parseConfig(makeEnv({ ENCRYPTION_KEY: KEY_HEX, TRANSFER_MODE: "presigned", ...credentials }))).toThrow(
      /cannot be used with ENCRYPTION_KEY/,
    );

    const info = await handle(new Request("https://lfs.example.com/_r2-lfs/info"), makeEnv({ ENCRYPTION_KEY: KEY_HEX, ...credentials }), {
      fetch,
    });
    expect(await info.json()).toMatchObject({ encrypted: true, transfer: "proxy" });
  });
});
