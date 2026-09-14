import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { RepositoryStorage } from "../../src/app/ports.ts";
import { changeObjects } from "../../src/app/repository-storage.ts";
import { parseConfig } from "../../src/domain/config.ts";
import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";
import { R2RepositoryStorage } from "../../src/infra/r2-repository-storage.ts";
import type { BatchObjectResult, StorageChanges, StorageListing } from "../../src/shared/contract.ts";

const ORIGIN = "https://lfs.example.com";
const ADMIN = "a".repeat(32);
const WRITE = "w".repeat(32);
const READ = "r".repeat(32);

const makeEnv = (over: Partial<Env> = {}): Env => ({
  BUCKET: env.BUCKET,
  LOCKS: env.LOCKS,
  ALLOWED_REPOS: "acme/*",
  AUTH_MODE: "token",
  TRANSFER_MODE: "proxy",
  AUTH_TOKENS: `acme/*:admin:${ADMIN},acme/*:rw:${WRITE},acme/*:r:${READ}`,
  ...over,
});

const noHost = () => {
  throw new Error("the host API must not be called");
};

function call(
  e: Env,
  path: string,
  token: string,
  init: { method?: string; json?: unknown; body?: Uint8Array; authorization?: string } = {},
) {
  const headers = new Headers({ Authorization: init.authorization ?? `Basic ${btoa(`git:${token}`)}` });
  if (init.body) headers.set("Content-Length", String(init.body.byteLength));
  const body = init.json === undefined ? init.body : JSON.stringify(init.json);
  const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
  return handle(new Request(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body }), e, { fetch: noHost });
}

async function store(e: Env, repo: string, size = 48) {
  const data = crypto.getRandomValues(new Uint8Array(size));
  const oid = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await call(e, `/${repo}/objects/batch`, WRITE, { json: { operation: "upload", objects: [{ oid, size }] } });
  const upload = ((await res.json()) as { objects: BatchObjectResult[] }).objects[0]!.actions!.upload!;
  expect((await call(e, upload.href, "", { method: "PUT", body: data, authorization: upload.header!.Authorization })).status).toBe(200);
  return { oid, size };
}

const list = async (e: Env, repo: string, where: string, token = READ) => {
  const res = await call(e, `/${repo}/r2-lfs/objects?in=${where}`, token);
  return { status: res.status, body: (await res.json()) as StorageListing & { message?: string } };
};

const change = async (e: Env, repo: string, action: string, oids: unknown, token = ADMIN) => {
  const res = await call(e, `/${repo}/r2-lfs/objects/${action}`, token, { json: { oids } });
  return { status: res.status, body: (await res.json()) as StorageChanges & { message?: string } };
};

describe("storage through the Worker", () => {
  it("lists, trashes and restores a repository's objects, each with the permission it needs", async () => {
    const e = makeEnv();
    const repo = `acme/storage-${Date.now()}`;
    const kept = await store(e, repo);
    const old = await store(e, repo);
    await env.BUCKET.put(`${repo}/README`, "not an object");

    const live = await list(e, repo, "live");
    expect(live.status).toBe(200);
    expect(live.body.objects.map((o) => o.oid).toSorted()).toEqual([kept.oid, old.oid].toSorted());
    expect(live.body.objects[0]).toMatchObject({ size: 48, storage_class: "STANDARD", uploaded: expect.any(String) });

    // Only administrators move objects to the trash; writers may bring them back.
    expect((await change(e, repo, "trash", [old.oid], WRITE)).status).toBe(403);
    expect((await change(e, repo, "trash", [old.oid])).body.results).toEqual([{ oid: old.oid, outcome: "trashed" }]);
    expect((await list(e, repo, "live")).body.objects.map((o) => o.oid)).toEqual([kept.oid]);
    expect((await list(e, repo, "trash")).body.objects.map((o) => o.oid)).toEqual([old.oid]);
    const gone = await call(e, `/${repo}/objects/batch`, READ, { json: { operation: "download", objects: [old] } });
    expect(((await gone.json()) as { objects: BatchObjectResult[] }).objects[0]?.error?.code).toBe(404);

    expect((await change(e, repo, "restore", [old.oid], READ)).status).toBe(403);
    expect((await change(e, repo, "restore", [old.oid], WRITE)).body.results).toEqual([{ oid: old.oid, outcome: "restored" }]);
    expect((await list(e, repo, "trash")).body.objects).toEqual([]);
    const back = await call(e, `/${repo}/objects/${old.oid}`, "", {
      authorization: (
        (await (await call(e, `/${repo}/objects/batch`, READ, { json: { operation: "download", objects: [old] } })).json()) as {
          objects: BatchObjectResult[];
        }
      ).objects[0]!.actions!.download!.header!.Authorization,
    });
    expect(back.status).toBe(200);

    expect((await change(e, repo, "tier", [kept.oid])).body.results).toEqual([{ oid: kept.oid, outcome: "tiered" }]);
    const missing = "0".repeat(64);
    expect((await change(e, repo, "trash", [missing])).body.results).toEqual([{ oid: missing, outcome: "missing" }]);
  });

  it("validates requests, and refuses the shared layout and tokens issued for one transfer", async () => {
    const e = makeEnv();
    const repo = "acme/storage-checks";
    expect((await list(e, repo, "everywhere")).status).toBe(422);
    expect((await change(e, repo, "trash", [])).status).toBe(422);
    expect((await change(e, repo, "trash", ["not-an-oid"])).status).toBe(422);
    expect(
      (
        await change(
          e,
          repo,
          "trash",
          Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(64, "0")),
        )
      ).status,
    ).toBe(422);
    expect((await call(e, `/${repo}/r2-lfs/objects/trash`, ADMIN, { method: "GET" })).status).toBe(405);

    const shared = await list(makeEnv({ STORAGE_LAYOUT: "shared" }), repo, "live");
    expect(shared.status).toBe(409);
    expect(shared.body.message).toContain("R2 API credentials");

    const object = await store(e, repo);
    const res = await call(e, `/${repo}/objects/batch`, READ, { json: { operation: "download", objects: [object] } });
    const scoped = ((await res.json()) as { objects: BatchObjectResult[] }).objects[0]!.actions!.download!.header!.Authorization;
    expect((await call(e, `/${repo}/r2-lfs/objects?in=live`, "", { authorization: scoped })).status).toBe(403);
  });

  it("lets a workflow's OIDC token administer its repository when ACTIONS_OIDC is admin", () => {
    expect(parseConfig(makeEnv({ ACTIONS_OIDC: "admin" })).actionsOidc?.permission).toBe("admin");
  });
});

function fakeStorage(deleteLive: () => Promise<"deleted" | "locked">, liveAfter: { size: number; storageClass: string } | null | Error) {
  const deleted: string[] = [];
  const storage: RepositoryStorage = {
    list: async () => ({ objects: [] }),
    head: async () => {
      if (liveAfter instanceof Error) throw liveAfter;
      return liveAfter;
    },
    copy: async () => "copied",
    delete: async (key) => {
      if (key.startsWith("_trash/")) {
        deleted.push(key);
        return "deleted";
      }
      return deleteLive();
    },
  };
  return { storage, deleted };
}
const failing = async (): Promise<"deleted"> => {
  throw new Error("timed out");
};

describe("trashing when R2 refuses", () => {
  const oid = "b".repeat(64);
  const config = parseConfig(makeEnv());
  const repo = { owner: "acme", name: "locked" };

  it("reports objects a bucket lock protects as locked and drops the trash copy", async () => {
    const { storage, deleted } = fakeStorage(async () => "locked", { size: 1, storageClass: "Standard" });
    const result = await changeObjects({ config, repo, permission: "admin", storage }, "trash", { oids: [oid] });
    expect(result).toEqual({ ok: true, value: { results: [{ oid, outcome: "locked" }] } });
    expect(deleted).toEqual([`_trash/acme/locked/${oid}`]);
  });

  it("keeps the trash copy unless the object is known to be still in place after a failed delete", async () => {
    const stillThere = fakeStorage(failing, { size: 1, storageClass: "Standard" });
    expect(await changeObjects({ config, repo, permission: "admin", storage: stillThere.storage }, "trash", { oids: [oid] })).toMatchObject(
      {
        value: { results: [{ oid, outcome: "failed", message: "timed out" }] },
      },
    );
    expect(stillThere.deleted).toHaveLength(1);

    const actuallyGone = fakeStorage(failing, null);
    expect(
      await changeObjects({ config, repo, permission: "admin", storage: actuallyGone.storage }, "trash", { oids: [oid] }),
    ).toMatchObject({
      value: { results: [{ oid, outcome: "trashed" }] },
    });
    expect(actuallyGone.deleted).toEqual([]);

    const unknown = fakeStorage(failing, new Error("head failed"));
    expect(await changeObjects({ config, repo, permission: "admin", storage: unknown.storage }, "trash", { oids: [oid] })).toMatchObject({
      value: { results: [{ oid, outcome: "failed" }] },
    });
    expect(unknown.deleted).toEqual([]);
  });
});

describe("R2RepositoryStorage", () => {
  it("reads sources with the key only when they are encrypted, encrypts copies, and recognises bucket lock refusals", async () => {
    const calls: { method: string; key: string; options: unknown }[] = [];
    const bucket = {
      head: async (key: string) => ({ size: 6, storageClass: "Standard", ssecKeyMd5: key.includes("encrypted") ? "md5" : undefined }),
      get: async (key: string, options: unknown) => {
        calls.push({ method: "get", key, options });
        return { body: new Response("secret").body, size: 6 };
      },
      put: async (key: string, body: ReadableStream, options: unknown) => {
        calls.push({ method: "put", key, options });
        await new Response(body).arrayBuffer();
        if (key.startsWith("locked/")) throw new Error("put: Object is protected by a bucket lock rule (10069)");
        return {};
      },
      delete: async (key: string) => {
        if (key.startsWith("locked/")) throw new Error("delete: Object is protected by a bucket lock rule (10069)");
      },
    } as unknown as R2Bucket;
    const storage = new R2RepositoryStorage(bucket, "0f".repeat(32));
    const sha256 = "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b";

    expect(await storage.copy("plain/a", "_trash/plain/a", { sha256 })).toBe("copied");
    expect(await storage.copy("encrypted/b", "_trash/encrypted/b", { sha256 })).toBe("copied");
    expect(calls.map((c) => [c.method, c.key, (c.options as { ssecKey?: string }).ssecKey !== undefined])).toEqual([
      ["get", "plain/a", false],
      ["put", "_trash/plain/a", true],
      ["get", "encrypted/b", true],
      ["put", "_trash/encrypted/b", true],
    ]);
    expect(await storage.copy("plain/c", "locked/c", { sha256, storageClass: "InfrequentAccess" })).toBe("locked");
    expect(await storage.delete("locked/c")).toBe("locked");
    expect(await storage.delete("plain/c")).toBe("deleted");
  });
});
