import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../src/domain/config.ts";
import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";
import { clearUsageCache } from "../../src/infra/r2-object-store.ts";
import { clearStoredTokensCache } from "../../src/infra/token-directory.ts";
import { basic, envWith } from "./helpers.ts";

const TOKEN = "q".repeat(32);
const oid = (n: number) => n.toString(16).padStart(64, "0");

const makeEnv = envWith({ AUTH_MODE: "token", TRANSFER_MODE: "proxy", PROXY_MAX_UPLOAD_MB: "100", AUTH_TOKENS: `acme/*:rw:${TOKEN}` });

async function batch(e: Env, repo: string, objects: { oid: string; size: number }[]) {
  const res = await handle(
    new Request(`https://lfs.example.com/acme/${repo}/objects/batch`, {
      method: "POST",
      headers: { Authorization: basic(TOKEN, "x") },
      body: JSON.stringify({ operation: "upload", objects }),
    }),
    e,
    { fetch: fetch },
  );
  return ((await res.json()) as { objects: { oid: string; actions?: unknown; error?: { code: number; message: string } }[] }).objects;
}

beforeEach(() => {
  clearUsageCache();
  clearStoredTokensCache();
});

describe("storage limits", () => {
  it("refuses objects above MAX_OBJECT_MB before any transfer", async () => {
    const [small, big] = await batch(makeEnv({ MAX_OBJECT_MB: "1" }), "limits-size", [
      { oid: oid(1), size: 1024 ** 2 },
      { oid: oid(2), size: 1024 ** 2 + 1 },
    ]);
    expect(small?.actions).toBeDefined();
    expect(big?.error).toEqual({ code: 422, message: expect.stringContaining("1 MB") });
  });

  it("stops uploads that would take a repository over QUOTA_GB, counting what the batch adds", async () => {
    const repo = `limits-quota-${Date.now()}`;
    await env.BUCKET.put(`acme/${repo}/${oid(9)}`, new Uint8Array(600));
    const quota = String(1000 / 1024 ** 3);
    const results = await batch(makeEnv({ QUOTA_GB: quota }), repo, [
      { oid: oid(3), size: 300 },
      { oid: oid(4), size: 200 },
      { oid: oid(5), size: 50 },
    ]);
    expect(results.map((r) => r.error?.code ?? "upload")).toEqual(["upload", 507, "upload"]);
    // Other repositories have their own quota in the per-repo layout.
    expect((await batch(makeEnv({ QUOTA_GB: quota }), `${repo}-other`, [{ oid: oid(4), size: 200 }]))[0]?.actions).toBeDefined();
  });

  it("validates the limits", () => {
    expect(() => parseConfig(makeEnv({ QUOTA_GB: "-1" }))).toThrow(/QUOTA_GB must be a positive number/);
    expect(() => parseConfig(makeEnv({ MAX_OBJECT_MB: "lots" }))).toThrow(/MAX_OBJECT_MB must be a positive number/);
    expect(parseConfig(makeEnv()).quotaBytes).toBeUndefined();
  });
});

describe("metrics", () => {
  it("records each repository request in Workers Analytics Engine", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const METRICS = { writeDataPoint: (point: AnalyticsEngineDataPoint) => points.push(point) } as AnalyticsEngineDataset;
    await batch(makeEnv({ METRICS }), "Metrics", [{ oid: oid(6), size: 1 }]);
    await handle(new Request("https://lfs.example.com/acme/metrics/objects/batch", { method: "POST", body: "{}" }), makeEnv({ METRICS }), {
      fetch: fetch,
    });
    await handle(new Request("https://lfs.example.com/_r2-lfs/info"), makeEnv({ METRICS }), { fetch: fetch });
    expect(points).toEqual([
      { indexes: ["acme/metrics"], blobs: ["acme/metrics", "batch", "POST", "2xx"], doubles: [0, 200] },
      { indexes: ["acme/metrics"], blobs: ["acme/metrics", "batch", "POST", "4xx"], doubles: [0, 401] },
    ]);
  });
});
