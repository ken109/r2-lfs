import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { recentActivity } from "../../src/app/admin-activity.ts";
import { forceUnlock, parseRepository, repositoryLocks } from "../../src/app/admin-locks.ts";
import { storageReport } from "../../src/app/admin-storage.ts";
import { createToken, listTokens, revokeToken } from "../../src/app/admin-tokens.ts";
import type { BucketLister } from "../../src/app/ports.ts";
import { parseConfig } from "../../src/domain/config.ts";
import { AnalyticsSqlActivity } from "../../src/infra/analytics-sql.ts";
import { R2BucketLister } from "../../src/infra/r2-bucket-lister.ts";
import { R2TokensFile, RandomTokenMinter } from "../../src/infra/r2-tokens-file.ts";
import { DurableObjectLockStore } from "../../src/infra/repo-locks.ts";
import { CombinedTokenDirectory } from "../../src/infra/token-directory.ts";
import { formatCount, formatDate, formatRelative } from "../../src/routes/[_]admin/-format.ts";
import { TOKENS_KEY } from "../../src/shared/contract.ts";

const OID = (n: number) => n.toString(16).padStart(64, "0");

// Storage is isolated per test, so each report sees only the objects its test wrote.
const tokenDeps = () => ({
  store: new R2TokensFile(env.BUCKET),
  minter: new RandomTokenMinter(),
  now: () => new Date("2026-09-14T00:00:00Z"),
});

describe("admin tokens", () => {
  it("creates a token the Worker accepts at once, lists it without its hash and revokes it", async () => {
    const created = await createToken(tokenDeps(), { label: "ci", scope: "Acme/*", permission: "write" });
    if (!created.ok) throw new Error(created.message);
    expect(created.value.token).toMatch(/^r2lfs_[\w-]{43}$/);
    expect(created.value.entry).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      label: "ci",
      scope: "acme/*",
      permission: "write",
      created: "2026-09-14T00:00:00.000Z",
    });
    expect(await (await env.BUCKET.get(TOKENS_KEY))!.text()).not.toContain(created.value.token);

    const directory = new CombinedTokenDirectory([], env.BUCKET);
    expect(await directory.grantsFor(created.value.token)).toEqual([{ scope: "acme/*", permission: "write", holder: "ci" }]);

    const listed = await listTokens(new R2TokensFile(env.BUCKET));
    expect(listed).toEqual({ ok: true, value: [created.value.entry] });

    expect(await revokeToken(new R2TokensFile(env.BUCKET), created.value.entry.id)).toMatchObject({ ok: true });
    expect(await directory.grantsFor(created.value.token)).toEqual([]);
    expect(await revokeToken(new R2TokensFile(env.BUCKET), created.value.entry.id)).toMatchObject({ ok: false, status: 404 });
  });

  it("validates input and refuses to overwrite a file someone changed in the meantime", async () => {
    expect(await createToken(tokenDeps(), { label: "x", scope: "acme", permission: "write" })).toMatchObject({ ok: false, status: 422 });
    expect(await createToken(tokenDeps(), { label: "x", scope: "acme/*", permission: "owner" })).toMatchObject({ ok: false, status: 422 });
    expect(await createToken(tokenDeps(), { label: " ", scope: "acme/*", permission: "read" })).toMatchObject({ ok: false, status: 422 });

    // Created by someone else between reading (nothing) and writing.
    const racing = new R2TokensFile(env.BUCKET);
    const read = racing.read.bind(racing);
    racing.read = async () => {
      const before = await read();
      await env.BUCKET.put(TOKENS_KEY, JSON.stringify({ version: 1, tokens: [] }));
      return before;
    };
    expect(await createToken({ ...tokenDeps(), store: racing }, { label: "a", scope: "*", permission: "read" })).toMatchObject({
      ok: false,
      status: 409,
    });

    // Changed by someone else after an existing file was read.
    expect(await createToken(tokenDeps(), { label: "a", scope: "*", permission: "read" })).toMatchObject({ ok: true });
    expect(await createToken({ ...tokenDeps(), store: racing }, { label: "b", scope: "*", permission: "read" })).toMatchObject({
      ok: false,
      status: 409,
    });

    await env.BUCKET.put(TOKENS_KEY, "not json");
    expect(await listTokens(new R2TokensFile(env.BUCKET))).toMatchObject({ ok: false, status: 500 });
  });
});

/** A bucket listing in pages of two, as R2 would page a larger one. */
function lister(objects: Record<string, number>): BucketLister {
  const keys = Object.keys(objects).toSorted();
  return {
    list: async (cursor) => {
      const start = Number(cursor ?? 0);
      const page = keys.slice(start, start + 2).map((key) => ({ key, size: objects[key]! }));
      return { objects: page, ...(start + 2 < keys.length ? { cursor: String(start + 2) } : {}) };
    },
  };
}

describe("admin storage report", () => {
  it("totals each repository, the trash and staged uploads in the per-repo layout", async () => {
    const bucket = lister({
      [`acme/game/${OID(1)}`]: 300,
      [`acme/game/${OID(2)}`]: 200,
      [`acme/web/${OID(3)}`]: 100,
      [`_trash/acme/game/${OID(4)}`]: 50,
      [`_incoming/acme/web/${OID(5)}`]: 7,
      [TOKENS_KEY]: 2,
    });
    expect(await storageReport(bucket, "per-repo")).toEqual({
      repositories: [
        { repo: "acme/game", objects: 2, bytes: 500 },
        { repo: "acme/web", objects: 1, bytes: 100 },
      ],
      total: { objects: 3, bytes: 600 },
      trash: { objects: 1, bytes: 50 },
      incoming: { objects: 1, bytes: 7 },
      truncated: false,
    });
  });

  it("counts each repository's uploads in the shared layout, and says when it stopped early", async () => {
    const bucket = lister({
      [`_shared/${OID(1)}`]: 300,
      [`_shared/${OID(2)}`]: 200,
      [`_members/acme/game/${OID(1)}`]: 0,
      [`_members/acme/web/${OID(1)}`]: 0,
      [`_members/acme/web/${OID(2)}`]: 0,
    });
    const report = await storageReport(bucket, "shared");
    expect(report.repositories).toEqual([
      { repo: "acme/web", objects: 2, bytes: 500 },
      { repo: "acme/game", objects: 1, bytes: 300 },
    ]);
    expect(report.total).toEqual({ objects: 2, bytes: 500 });

    const endless: BucketLister = { list: async () => ({ objects: [{ key: `a/b/${OID(9)}`, size: 1 }], cursor: "more" }) };
    expect(await storageReport(endless, "per-repo", 3)).toMatchObject({ truncated: true, total: { objects: 3, bytes: 3 } });
  });

  it("lists the R2 bucket with keys and sizes", async () => {
    await env.BUCKET.put(`lister/repo/${OID(1)}`, new Uint8Array(42));
    const page = await new R2BucketLister(env.BUCKET).list(undefined);
    expect(page.objects).toContainEqual({ key: `lister/repo/${OID(1)}`, size: 42 });
  });
});

describe("admin locks", () => {
  it("parses repositories, lists a repository's locks and removes one", async () => {
    expect(parseRepository(" acme/game.git ")).toEqual({ owner: "acme", name: "game" });
    expect(parseRepository("acme/..")).toBeUndefined();
    expect(parseRepository("acme")).toBeUndefined();
    expect(parseRepository(42)).toBeUndefined();

    const store = new DurableObjectLockStore(env.LOCKS, { owner: "acme", name: `admin-${Date.now()}` });
    const { lock } = await store.create("scene.blend", "someone");
    expect((await repositoryLocks(store)).locks).toEqual([lock]);
    expect(await forceUnlock(store, lock.id)).toEqual({ ok: true, value: lock });
    expect((await repositoryLocks(store)).locks).toEqual([]);
    expect(await forceUnlock(store, lock.id)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("admin activity", () => {
  it("queries Analytics Engine by repository when an API token is configured", async () => {
    const seen: { url: string; auth: string | null; body: string }[] = [];
    const source = new AnalyticsSqlActivity(
      async (input, init) => {
        const request = new Request(input, init);
        seen.push({ url: request.url, auth: request.headers.get("Authorization"), body: await request.text() });
        return Response.json({ data: [{ repo: "acme/game", requests: "12", bytes: 3456, errors: "1" }] });
      },
      { accountId: "acc123", apiToken: "api-token" },
    );
    expect(await recentActivity(source, 24)).toEqual({
      ok: true,
      value: { enabled: true, hours: 24, repositories: [{ repo: "acme/game", requests: 12, bytes: 3456, errors: 1 }] },
    });
    expect(seen[0]).toMatchObject({
      url: "https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql",
      auth: "Bearer api-token",
    });
    expect(seen[0]?.body).toContain("FROM r2_lfs");
    expect(seen[0]?.body).toContain("INTERVAL '24' HOUR");

    expect(await recentActivity(source, 0.5)).toMatchObject({ ok: false, status: 422 });
    expect(await recentActivity(undefined, 24)).toEqual({ ok: true, value: { enabled: false } });
    const failing = new AnalyticsSqlActivity(async () => new Response("denied", { status: 403 }), { accountId: "a", apiToken: "t" });
    expect(await recentActivity(failing, 1)).toMatchObject({ ok: false, status: 502, message: expect.stringContaining("403") });
  });

  it("needs the account id to query analytics, and only warns without it", () => {
    const base = { ALLOWED_REPOS: "acme/*", AUTH_MODE: "token" };
    expect(parseConfig({ ...base, ANALYTICS_API_TOKEN: "t", R2_ACCOUNT_ID: "acc" }).analytics).toEqual({ accountId: "acc", apiToken: "t" });
    expect(parseConfig(base).analytics).toBeUndefined();
    const withoutAccount = parseConfig({ ...base, ANALYTICS_API_TOKEN: "t" });
    expect(withoutAccount.analytics).toBeUndefined();
    expect(withoutAccount.warnings).toEqual([expect.stringContaining("R2_ACCOUNT_ID")]);
  });
});

describe("admin UI formatting", () => {
  it("renders dates the same in the Worker and in any browser, and relative times from a given now", () => {
    expect(formatDate("2026-09-14T08:05:59.123Z")).toBe("2026-09-14 08:05 UTC");
    expect(formatDate("not a date")).toBe("not a date");
    const now = Date.parse("2026-09-14T12:00:00Z");
    expect(formatRelative("2026-09-14T11:59:40Z", now)).toBe("this minute");
    expect(formatRelative("2026-09-14T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatRelative("2026-09-11T12:00:00Z", now)).toBe("3 days ago");
    expect(formatRelative("2026-08-14T12:00:00Z", now)).toBe("last month");
    expect(formatCount(1234567.4)).toBe("1,234,567");
  });
});
