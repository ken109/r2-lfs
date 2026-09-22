import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { bucketHoursFor, fillTimeline, recentActivity } from "../../src/app/admin-activity.ts";
import { forceUnlock, parseRepository, repositoryLocks, servedRepository } from "../../src/app/admin-locks.ts";
import { changeRepositoryObjects, repositoryObjects } from "../../src/app/admin-objects.ts";
import { rotateSessionKey } from "../../src/app/admin-sessions.ts";
import { countStorage, lastStorageReport, storageReport } from "../../src/app/admin-storage.ts";
import { createToken, listTokens, revokeToken } from "../../src/app/admin-tokens.ts";
import type { ActivitySource, BucketLister } from "../../src/app/ports.ts";
import { parseConfig } from "../../src/domain/config.ts";
import { AnalyticsSqlActivity } from "../../src/infra/analytics-sql.ts";
import { R2BucketLister } from "../../src/infra/r2-bucket-lister.ts";
import { R2RepositoryStorage } from "../../src/infra/r2-repository-storage.ts";
import { R2SessionKey } from "../../src/infra/r2-session-key.ts";
import { R2StorageReport, STORAGE_REPORT_KEY } from "../../src/infra/r2-storage-report.ts";
import { R2TokensFile, RandomTokenMinter } from "../../src/infra/r2-tokens-file.ts";
import { DurableObjectLockStore } from "../../src/infra/repo-locks.ts";
import { HmacSessionTokens } from "../../src/infra/session-tokens.ts";
import { CombinedTokenDirectory } from "../../src/infra/token-directory.ts";
import {
  chunks,
  countOutcomes,
  formatCount,
  formatDate,
  errorRate,
  formatRelative,
  olderThan,
  quotaShare,
  repositoryChoices,
  sortRows,
  splitRepository,
} from "../../src/routes/[_]admin/-format.ts";
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

  it("keeps the last count in the bucket, outside what it counts", async () => {
    const store = new R2StorageReport(env.BUCKET);
    expect(await lastStorageReport(store)).toBeUndefined();
    await env.BUCKET.put(`kept/repo/${OID(1)}`, new Uint8Array(10));
    const counted = await countStorage({
      lister: new R2BucketLister(env.BUCKET),
      layout: "per-repo",
      store,
      now: () => new Date("2026-09-14T00:00:00Z"),
    });
    expect(counted).toMatchObject({ countedAt: "2026-09-14T00:00:00.000Z", report: { total: { objects: 1, bytes: 10 } } });
    expect(await lastStorageReport(store)).toEqual(counted);

    // Counting again does not count the kept report.
    const again = await countStorage({ lister: new R2BucketLister(env.BUCKET), layout: "per-repo", store, now: () => new Date() });
    expect(again.report.total).toEqual({ objects: 1, bytes: 10 });

    await env.BUCKET.put(STORAGE_REPORT_KEY, "not json");
    expect(await lastStorageReport(store)).toBeUndefined();
    const failing = { read: async () => undefined, write: async () => Promise.reject(new Error("down")) };
    const kept = await countStorage({ lister: new R2BucketLister(env.BUCKET), layout: "per-repo", store: failing, now: () => new Date() });
    expect(kept.report.total.objects).toBe(1);
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

  it("accepts only repositories the server serves, and filters by path", async () => {
    expect(servedRepository(perRepo, "Acme/Game")).toEqual({ ok: true, value: { owner: "Acme", name: "Game" } });
    expect(servedRepository(perRepo, "other/game")).toMatchObject({
      ok: false,
      status: 422,
      message: expect.stringContaining("ALLOWED_REPOS"),
    });
    expect(servedRepository(perRepo, "acme")).toMatchObject({ ok: false, status: 422 });

    const store = new DurableObjectLockStore(env.LOCKS, { owner: "acme", name: `paths-${Date.now()}` });
    await store.create("a.blend", "someone");
    const { lock } = await store.create("b.blend", "someone");
    expect((await repositoryLocks(store, undefined, "b.blend")).locks).toEqual([lock]);
  });
});

describe("admin activity", () => {
  it("queries Analytics Engine by repository and over time when an API token is configured", async () => {
    const seen: { url: string; auth: string | null; body: string }[] = [];
    const source = new AnalyticsSqlActivity(
      async (input, init) => {
        const request = new Request(input, init);
        const body = await request.text();
        seen.push({ url: request.url, auth: request.headers.get("Authorization"), body });
        return Response.json({
          data: body.includes("toStartOfInterval")
            ? [
                { t: "2026-09-13 23:00:00", requests: "4", bytes: 0, errors: "0" },
                { t: "2026-09-14 01:00:00", requests: "8", bytes: 3456, errors: "1" },
              ]
            : [{ repo: "acme/game", requests: "12", bytes: 3456, errors: "1" }],
        });
      },
      { accountId: "acc123", apiToken: "api-token" },
    );

    const result = await recentActivity(source, 3, undefined, () => new Date("2026-09-14T01:30:00Z"));
    expect(result).toEqual({
      ok: true,
      value: {
        enabled: true,
        hours: 3,
        repositories: [{ repo: "acme/game", requests: 12, bytes: 3456, errors: 1 }],
        truncated: false,
        total: { requests: 12, bytes: 3456, errors: 1 },
        bucketHours: 1,
        timeline: [
          { start: "2026-09-13T22:00:00.000Z", requests: 0, bytes: 0, errors: 0 },
          { start: "2026-09-13T23:00:00.000Z", requests: 4, bytes: 0, errors: 0 },
          { start: "2026-09-14T00:00:00.000Z", requests: 0, bytes: 0, errors: 0 },
          { start: "2026-09-14T01:00:00.000Z", requests: 8, bytes: 3456, errors: 1 },
        ],
      },
    });
    expect(seen[0]).toMatchObject({
      url: "https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql",
      auth: "Bearer api-token",
    });
    expect(seen.map((s) => s.body)).toEqual([
      expect.stringMatching(/FROM r2_lfs[\s\S]*INTERVAL '3' HOUR[\s\S]*LIMIT 200/),
      expect.stringMatching(/toStartOfInterval\(timestamp, INTERVAL '1' HOUR\)[\s\S]*GROUP BY t/),
    ]);

    expect(await recentActivity(source, 0.5)).toMatchObject({ ok: false, status: 422 });
    expect(await recentActivity(undefined, 24)).toEqual({ ok: true, value: { enabled: false } });
    const failing = new AnalyticsSqlActivity(async () => new Response("denied", { status: 403 }), { accountId: "a", apiToken: "t" });
    expect(await recentActivity(failing, 1)).toMatchObject({ ok: false, status: 502, message: expect.stringContaining("403") });
  });

  it("says when the repository list stopped at its limit, and widens buckets for long periods", async () => {
    const full: ActivitySource = {
      byRepository: async (_hours, _repo, limit = 200) =>
        Array.from({ length: limit }, (_, i) => ({ repo: `acme/r${i}`, requests: 1, bytes: 0, errors: 0 })),
      timeline: async () => [],
    };
    expect(await recentActivity(full, 24)).toMatchObject({ ok: true, value: { truncated: true } });
    expect([1, 24, 24 * 7, 24 * 30, 24 * 90].map(bucketHoursFor)).toEqual([1, 1, 1, 6, 24]);
    expect(fillTimeline([], 24 * 90, 24, new Date("2026-09-14T12:00:00Z"))).toHaveLength(91);
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

async function sha256(data: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const perRepo = parseConfig({ ALLOWED_REPOS: "acme/*", AUTH_MODE: "token" });
const deps = (config = perRepo) => ({ config, storage: new R2RepositoryStorage(env.BUCKET) });

describe("admin repository objects", () => {
  it("lists, trashes and restores a repository's objects as its administrator", async () => {
    const data = new TextEncoder().encode("scene");
    const oid = await sha256(data);
    await env.BUCKET.put(`acme/objects/${oid}`, data);

    const live = await repositoryObjects(deps(), "Acme/Objects", "live", undefined);
    expect(live).toMatchObject({ ok: true, value: { repository: "acme/objects", objects: [{ oid, size: 5, storage_class: "STANDARD" }] } });

    expect(await changeRepositoryObjects(deps(), "acme/objects", "trash", [oid])).toEqual({
      ok: true,
      value: { results: [{ oid, outcome: "trashed" }] },
    });
    expect(await repositoryObjects(deps(), "acme/objects", "trash", "")).toMatchObject({ ok: true, value: { objects: [{ oid }] } });
    expect(await changeRepositoryObjects(deps(), "acme/objects", "restore", [oid])).toMatchObject({
      ok: true,
      value: { results: [{ oid, outcome: "restored" }] },
    });
    expect(await env.BUCKET.head(`acme/objects/${oid}`)).not.toBeNull();
  });

  it("refuses bad input, more than one request's worth of oids and the shared layout", async () => {
    expect(await repositoryObjects(deps(), "acme", "live", undefined)).toMatchObject({ ok: false, status: 422 });
    expect(await repositoryObjects(deps(), "acme/x", "elsewhere", undefined)).toMatchObject({ ok: false, status: 422 });
    expect(await changeRepositoryObjects(deps(), "acme/x", "delete", [OID(1)])).toMatchObject({ ok: false, status: 422 });
    const eleven = Array.from({ length: 11 }, (_, i) => OID(i));
    expect(await changeRepositoryObjects(deps(), "acme/x", "trash", eleven)).toMatchObject({ ok: false, status: 422 });
    const shared = parseConfig({ ALLOWED_REPOS: "acme/*", AUTH_MODE: "token", STORAGE_LAYOUT: "shared" });
    expect(await repositoryObjects(deps(shared), "acme/x", "live", undefined)).toMatchObject({
      ok: false,
      status: 409,
      message: expect.stringContaining("shared layout"),
    });
  });

  it("queries one repository's activity", async () => {
    const bodies: string[] = [];
    const source = new AnalyticsSqlActivity(
      async (input, init) => {
        bodies.push(await new Request(input, init).text());
        return Response.json({ data: [] });
      },
      { accountId: "a", apiToken: "t" },
    );
    expect(await recentActivity(source, 24, "Acme/Game")).toMatchObject({ ok: true });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toContain("AND blob1 = 'acme/game'");
    expect(await recentActivity(source, 24, "acme")).toMatchObject({ ok: false, status: 422 });
  });
});

describe("admin session key", () => {
  it("rotates the key, revoking the tokens signed with it", async () => {
    const sessions = new HmacSessionTokens(env.BUCKET);
    const token = await sessions.mint({ repo: "acme/game", permission: "write", expires: Math.floor(Date.now() / 1000) + 600 });
    expect(await sessions.verify(token)).toMatchObject({ repo: "acme/game" });

    expect(await rotateSessionKey({ keys: new R2SessionKey(env.BUCKET), now: () => new Date("2026-09-14T00:00:00Z") })).toEqual({
      ok: true,
      value: { rotatedAt: "2026-09-14T00:00:00.000Z" },
    });
    expect(await sessions.verify(token)).toBeUndefined();

    const broken = { rotate: async () => Promise.reject(new Error("R2 is down")) };
    expect(await rotateSessionKey({ keys: broken, now: () => new Date() })).toMatchObject({ ok: false, status: 502 });
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

  it("splits selections into requests and counts their outcomes", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 10)).toEqual([]);
    expect(countOutcomes([{ outcome: "trashed" }, { outcome: "locked" }, { outcome: "trashed" }])).toEqual([
      { outcome: "trashed", count: 2 },
      { outcome: "locked", count: 1 },
    ]);
    expect(splitRepository("acme/game")).toEqual({ owner: "acme", name: "game" });
    expect(splitRepository("")).toBeUndefined();
    expect(splitRepository("a/b/c")).toBeUndefined();
  });

  it("sorts rows by a column and measures quota use", () => {
    const rows = [
      { repo: "b", bytes: 1 },
      { repo: "a", bytes: 3 },
      { repo: "c", bytes: 2 },
    ];
    expect(sortRows(rows, "bytes", "descending").map((r) => r.repo)).toEqual(["a", "c", "b"]);
    expect(sortRows(rows, "repo", "ascending").map((r) => r.repo)).toEqual(["a", "b", "c"]);
    expect(quotaShare(80, 100)).toBe(0.8);
    expect(quotaShare(80, undefined)).toBeUndefined();
    expect(errorRate(3, 200)).toBe("1.5%");
    expect(errorRate(0, 0)).toBe("–");
  });

  it("marks old locks and suggests repositories", () => {
    const now = Date.parse("2026-09-14T00:00:00Z");
    expect(olderThan("2026-09-06T00:00:00Z", 7, now)).toBe(true);
    expect(olderThan("2026-09-08T00:00:00Z", 7, now)).toBe(false);
    expect(repositoryChoices(["acme/*", "acme/game", "*"], ["acme/web", "acme/game"])).toEqual(["acme/game", "acme/web"]);
  });
});
