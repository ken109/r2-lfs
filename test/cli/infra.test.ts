import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConflictError, TransferError } from "../../cli/app/ports.ts";
import { credentialLauncherScript, launcherFileName, launcherScript } from "../../cli/domain/launchers.ts";
import { parseLfsUrl } from "../../cli/domain/remote.ts";
import { GithubActionsIdTokens } from "../../cli/infra/actions-id-token.ts";
import { Git } from "../../cli/infra/git.ts";
import { HttpLfsClient } from "../../cli/infra/lfs-client.ts";
import { LocalFiles } from "../../cli/infra/local-files.ts";
import { FileUploadStates, HttpMultipartUploads, readFileRange } from "../../cli/infra/multipart-uploads.ts";
import { findOnPath } from "../../cli/infra/proc.ts";
import { parseListObjects, R2Bucket, ssecHeaders } from "../../cli/infra/r2-bucket.ts";
import { ServerStorage } from "../../cli/infra/server-storage.ts";
import { FileSessionCache } from "../../cli/infra/session-cache.ts";
import { TarWriter } from "../../cli/infra/tar-writer.ts";
import { parseWhoami } from "../../cli/infra/wrangler-cli.ts";
import { TempRepo } from "./helpers.ts";

describe("Git adapter", () => {
  let repo: TempRepo;

  afterEach(() => repo.remove());

  it("finds pointers in history, tips and recent commits", () => {
    repo = new TempRepo();
    const v1 = repo.writeLfs("scene.blend", "version one");
    repo.write("notes.txt", "not an LFS file");
    const oldCommit = repo.commit("first", 200);
    const v2 = repo.writeLfs("scene.blend", "version two");
    const tex = repo.writeLfs("textures/wood.png", "wood");
    repo.commit("second", 1);
    repo.git("tag", "-a", "v1", oldCommit, "-m", "annotated tag");

    const git = Git.open(repo.dir);
    const history = git.pointerHistory();
    expect(history.map((c) => [c.path, c.oid])).toEqual(
      expect.arrayContaining([
        ["scene.blend", v1],
        ["scene.blend", v2],
        ["textures/wood.png", tex],
      ]),
    );

    const tips = git.pointersIn(git.refTips());
    expect([...tips.keys()].toSorted()).toEqual([v1, v2, tex].toSorted());
    expect([...(tips.get(tex)?.paths ?? [])]).toEqual(["textures/wood.png"]);

    const recent = git.commitsSince(Math.floor(Date.now() / 1000) - 30 * 86_400);
    expect(recent).toHaveLength(1);
    expect([...git.pointersIn(recent.map((c) => c.sha)).keys()].toSorted()).toEqual([v2, tex].toSorted());
  });

  it("reads lfs.url from git config before .lfsconfig and resolves tags", () => {
    repo = new TempRepo();
    repo.write(".lfsconfig", '[lfs]\n\turl = "https://committed.example.com/a/b"\n');
    repo.commit("config");
    repo.git("tag", "release");
    const git = Git.open(repo.dir);
    expect(git.lfsUrl()).toBe("https://committed.example.com/a/b");
    repo.git("config", "lfs.url", "https://local.example.com/a/b");
    expect(git.lfsUrl()).toBe("https://local.example.com/a/b");
    expect(git.hasTag("release")).toBe(true);
    expect(git.hasTag("nope")).toBe(false);
    expect(() => git.resolveCommit("nope")).toThrow(/not a commit/);
  });

  it("ignores binary blobs that are small but not pointers", () => {
    repo = new TempRepo();
    writeFileSync(join(repo.dir, "icon.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x0a, 0xc3, 0x28]));
    const oid = repo.writeLfs("model.glb", "glb");
    repo.commit("mixed");
    expect([...Git.open(repo.dir).pointersIn(Git.open(repo.dir).refTips()).keys()]).toEqual([oid]);
  });

  it("finds recent commits behind a commit with an older date", () => {
    repo = new TempRepo();
    repo.writeLfs("a.blend", "recent");
    repo.commit("recent", 5);
    repo.writeLfs("a.blend", "skewed");
    repo.commit("skewed clock", 400);
    repo.writeLfs("a.blend", "tip");
    repo.commit("tip", 1);
    const recent = Git.open(repo.dir).commitsSince(Math.floor(Date.now() / 1000) - 90 * 86_400);
    expect(recent).toHaveLength(2);
  });

  it("records pointers from root commits, merged branches, renames and non-ASCII paths regardless of log settings", () => {
    repo = new TempRepo();
    repo.git("config", "log.showRoot", "false");
    repo.git("config", "log.showSignature", "true");
    const root = repo.writeLfs("scene.blend", "root version");
    repo.commit("root");
    repo.git("switch", "-q", "-c", "side");
    const side = repo.writeLfs("テクスチャ/木 目.png", "wood grain");
    repo.commit("side");
    repo.git("switch", "-q", "main");
    repo.git("mv", "scene.blend", "renamed.blend");
    repo.commit("rename");
    repo.git("merge", "-q", "--no-ff", "side", "-m", "merge");

    const history = Git.open(repo.dir).pointerHistory();
    expect(history.map((c) => [c.path, c.oid])).toEqual(
      expect.arrayContaining([
        ["scene.blend", root],
        ["renamed.blend", root],
        ["テクスチャ/木 目.png", side],
      ]),
    );
  });

  it("fetches tags left behind by deleted branches and counts remote branches and lightweight tags as tips", () => {
    repo = new TempRepo();
    repo.commit("base");
    const clone = new TempRepo(repo);
    try {
      repo.git("switch", "-q", "-c", "release");
      const released = repo.commit("release");
      repo.git("tag", "-a", "v1", "-m", "v1");
      repo.git("switch", "-q", "-c", "feature", "main");
      const feature = repo.commit("feature");
      repo.git("switch", "-q", "main");
      repo.git("branch", "-D", "release");
      const detached = repo.commit("detached");
      repo.git("tag", "light", detached);
      repo.git("reset", "-q", "--hard", "HEAD~1");
      clone.git("tag", "local-only");
      // A tag the clone already has, moved on the remote afterwards.
      const localBase = clone.git("rev-parse", "HEAD").trim();
      clone.git("tag", "moving");
      repo.git("tag", "moving", feature);

      // Settings that make a plain fetch fail on the moved tag or prune local-only, and a push mirror that is unreachable.
      clone.git("config", "fetch.pruneTags", "true");
      clone.git("config", "remote.origin.tagOpt", "--tags");
      clone.git("config", "--add", "remote.origin.fetch", "refs/tags/*:refs/tags/*");
      clone.git("remote", "add", "--mirror=push", "backup", join(clone.dir, "missing.git"));

      const git = Git.open(clone.dir);
      expect(git.fetchAll()).toBe(true);
      expect(git.refTips()).toEqual(expect.arrayContaining([released, feature, detached]));
      expect(clone.git("tag", "--list", "local-only").trim()).toBe("local-only");
      expect(clone.git("rev-parse", "moving^{commit}").trim()).toBe(localBase);
    } finally {
      clone.remove();
    }
  });

  it("reports shallow, single-branch and branch-excluding clones as gaps in history, but not push-only remotes", () => {
    repo = new TempRepo();
    repo.commit("one");
    repo.commit("two");
    const full = new TempRepo(repo);
    const shallow = new TempRepo(repo, "--depth", "1", "--no-single-branch");
    const single = new TempRepo(repo, "--single-branch");
    try {
      full.git("remote", "add", "--mirror=push", "backup", join(full.dir, "backup.git"));
      full.git("remote", "add", "--mirror=push", "spare", join(full.dir, "spare.git"));
      full.git("config", "remote.spare.mirror", "yes");
      expect(Git.open(full.dir).historyGaps()).toEqual([]);
      full.git("remote", "add", "bare", join(full.dir, "bare.git"));
      full.git("config", "--unset-all", "remote.bare.fetch");
      expect(Git.open(full.dir).historyGaps()).toEqual([expect.stringContaining("remote bare fetches only some branches")]);
      full.git("remote", "remove", "bare");
      full.git("config", "--add", "remote.origin.fetch", "^refs/heads/big");
      expect(Git.open(full.dir).historyGaps()).toEqual([expect.stringContaining("only some branches")]);
      expect(Git.open(shallow.dir).historyGaps()).toEqual([expect.stringContaining("shallow")]);
      expect(Git.open(single.dir).historyGaps()).toEqual([expect.stringContaining("only some branches")]);
    } finally {
      for (const r of [full, shallow, single]) r.remove();
    }
  });
});

describe("R2Bucket against an S3-compatible server", () => {
  const objects = new Map<string, { body: string; etag: string; storageClass: string }>();
  const requests: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[] = [];
  let server: Server;
  let bucket: R2Bucket;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://s3");
      requests.push({ method: req.method ?? "", url: url.pathname + url.search, headers: req.headers });
      if (!String(req.headers.authorization).startsWith("AWS4-HMAC-SHA256")) {
        res.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
        return;
      }
      const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ""));
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).toSorted();
          const start = Number(url.searchParams.get("continuation-token") ?? 0);
          const page = all.slice(start, start + 2);
          const truncated = start + 2 < all.length;
          const contents = page
            .map(
              (k) =>
                `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>${objects.get(k)!.body.length}</Size><StorageClass>${objects.get(k)!.storageClass}</StorageClass></Contents>`,
            )
            .join("");
          res.end(
            `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}</ListBucketResult>`,
          );
        } else if (req.method === "HEAD") {
          res.writeHead(key.startsWith("unavailable/") ? 503 : objects.has(key) ? 200 : 404).end();
        } else if (req.method === "GET") {
          const object = objects.get(key);
          if (!object) res.writeHead(404).end();
          else res.writeHead(200, { ETag: object.etag }).end(object.body);
        } else if (req.method === "PUT" && req.headers["x-amz-copy-source"]) {
          const source = decodeURIComponent(String(req.headers["x-amz-copy-source"]).replace(/^\/bucket\//, ""));
          const object = objects.get(source);
          if (source.startsWith("broken/")) {
            // S3 can start a 200 response and still fail the copy.
            res.end("<Error><Code>InternalError</Code><Message>copy failed midway</Message></Error>");
            return;
          }
          if (!object) {
            res.writeHead(404).end("<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
            return;
          }
          objects.set(key, { ...object, storageClass: String(req.headers["x-amz-storage-class"] ?? object.storageClass) });
          res.end("<CopyObjectResult/>");
        } else if (req.method === "PUT") {
          const existing = objects.get(key);
          if (
            (req.headers["if-none-match"] === "*" && existing) ||
            (req.headers["if-match"] && existing?.etag !== req.headers["if-match"])
          ) {
            res.writeHead(412).end("<Error><Code>PreconditionFailed</Code></Error>");
            return;
          }
          objects.set(key, { body: Buffer.concat(chunks).toString(), etag: `"${Date.now()}${Math.random()}"`, storageClass: "STANDARD" });
          res.end();
        } else if (req.method === "DELETE") {
          if (key.startsWith("locked/")) {
            res
              .writeHead(403)
              .end("<Error><Code>ObjectLockedByBucketPolicy</Code><Message>Object is protected by a bucket lock rule</Message></Error>");
            return;
          }
          if (key.startsWith("denied/")) {
            res.writeHead(403).end("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
            return;
          }
          objects.delete(key);
          res.writeHead(204).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    bucket = new R2Bucket({
      bucket: "bucket",
      accountId: "acct",
      accessKeyId: "k",
      secretAccessKey: "s",
      endpoint: `http://127.0.0.1:${port}`,
      // The fake answers 503 on purpose; retrying with backoff would outlast the test timeout.
      retries: 0,
    });
  });

  afterAll(() => server.close());

  it("lists across pages, copies with a storage class and reports refused deletes", async () => {
    for (const key of ["p/a", "p/b", "p/c&d", "q/x", "locked/y"]) objects.set(key, { body: key, etag: '"1"', storageClass: "STANDARD" });

    expect((await bucket.list("p/")).map((o) => o.key)).toEqual(["p/a", "p/b", "p/c&d"]);
    expect((await bucket.copy("p/a", "p/a", "STANDARD_IA")).ok).toBe(true);
    expect(requests.at(-1)?.headers["x-amz-metadata-directive"]).toBe("REPLACE");
    expect((await bucket.list("p/a"))[0]?.storageClass).toBe("STANDARD_IA");
    expect(await bucket.copy("missing", "p/z")).toMatchObject({ ok: false, status: 404, message: "missing" });
    expect(await bucket.delete("locked/y")).toEqual({
      ok: false,
      status: 403,
      message: "Object is protected by a bucket lock rule",
      locked: true,
    });
    expect(await bucket.delete("denied/y")).toEqual({ ok: false, status: 403, message: "Access Denied" });
    expect((await bucket.delete("q/x")).ok).toBe(true);
  });

  it("treats an error inside a 200 copy response as a failure and checks whether keys exist", async () => {
    objects.set("broken/a", { body: "a", etag: '"1"', storageClass: "STANDARD" });
    expect(await bucket.copy("broken/a", "_trash/broken/a")).toMatchObject({ ok: false, status: 200, message: "copy failed midway" });
    expect(await bucket.exists("broken/a")).toBe(true);
    expect(await bucket.exists("broken/none")).toBe(false);
    await expect(bucket.exists("unavailable/a")).rejects.toThrow(/503/);
  });

  it("writes conditionally on the ETag it read", async () => {
    await bucket.put("_meta/tokens.json", "{}", { expectEtag: null });
    await expect(bucket.put("_meta/tokens.json", "{}", { expectEtag: null })).rejects.toBeInstanceOf(ConflictError);
    const current = await bucket.get("_meta/tokens.json");
    await bucket.put("_meta/tokens.json", '{"v":2}', { expectEtag: current!.etag! });
    await expect(bucket.put("_meta/tokens.json", '{"v":3}', { expectEtag: current!.etag! })).rejects.toBeInstanceOf(ConflictError);
    expect(await (await bucket.get("_meta/tokens.json"))!.text()).toBe('{"v":2}');
    expect(await bucket.get("_meta/none")).toBeUndefined();
  });

  it("sends the SSE-C key for both sides of a copy when the server encrypts", async () => {
    const encrypted = new R2Bucket({
      bucket: "bucket",
      accountId: "acct",
      accessKeyId: "k",
      secretAccessKey: "s",
      endpoint: (bucket as unknown as { endpoint: string }).endpoint.replace(/\/bucket$/, ""),
      retries: 0,
      encryptionKey: "0f".repeat(32),
    });
    objects.set("enc/a", { body: "a", etag: '"1"', storageClass: "STANDARD" });
    expect((await encrypted.copy("enc/a", "_trash/enc/a")).ok).toBe(true);
    const headers = requests.at(-1)!.headers;
    expect(headers["x-amz-server-side-encryption-customer-key"]).toBe(Buffer.alloc(32, 0x0f).toString("base64"));
    expect(headers["x-amz-copy-source-server-side-encryption-customer-algorithm"]).toBe("AES256");
    expect(encrypted.encrypted).toBe(true);
    expect(bucket.encrypted).toBe(false);
    expect(ssecHeaders(Buffer.alloc(32, 0x0f).toString("base64"))).toEqual(ssecHeaders("0f".repeat(32)));
    expect(() => ssecHeaders("short")).toThrow(/32 bytes/);
  });

  it("parses storage classes and defaults them", () => {
    const page = parseListObjects(
      "<ListBucketResult><Contents><Key>k</Key><LastModified>2026-01-01T00:00:00Z</LastModified><Size>1</Size></Contents></ListBucketResult>",
    );
    expect(page.objects[0]?.storageClass).toBe("STANDARD");
    expect(page.nextToken).toBeUndefined();
  });
});

describe("GithubActionsIdTokens", () => {
  it("requests a token for the audience with the job's request token", async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", auth: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ value: "id-token" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const env = {
        ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${port}/token?api-version=2.0`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "job-secret",
      };
      const tokens = new GithubActionsIdTokens(env);
      expect(tokens.available()).toBe(true);
      expect(await tokens.request("r2-lfs")).toBe("id-token");
      expect(seen).toEqual([{ url: "/token?api-version=2.0&audience=r2-lfs", auth: "bearer job-secret" }]);
      expect(new GithubActionsIdTokens({}).available()).toBe(false);
      expect(await new GithubActionsIdTokens({}).request("r2-lfs")).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe("HttpLfsClient", () => {
  it("splits large batches into requests of 100 objects and keeps the order", async () => {
    const sizes: number[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { objects: { oid: string; size: number }[] };
        sizes.push(body.objects.length);
        res.writeHead(200, { "Content-Type": "application/vnd.git-lfs+json" }).end(JSON.stringify({ objects: body.objects }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = new HttpLfsClient(parseLfsUrl(`http://127.0.0.1:${port}/acme/assets`)!, "token");
      const objects = Array.from({ length: 250 }, (_, i) => ({ oid: i.toString(16).padStart(64, "0"), size: i }));
      const results = await client.batch("download", objects);
      expect(sizes).toEqual([100, 100, 50]);
      expect(results.map((r) => r.size)).toEqual(objects.map((o) => o.size));
    } finally {
      server.close();
    }
  });

  it("trades its credentials at the session endpoint, and answers undefined when the server has none", async () => {
    const seen: { url?: string; authorization?: string }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      if (req.url === "/acme/assets/r2-lfs/session") {
        res.writeHead(200).end(JSON.stringify({ token: "r2lfs-s1.x", expires_at: "2026-09-14T01:00:00.000Z", permission: "write" }));
      } else res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = new HttpLfsClient(parseLfsUrl(`http://127.0.0.1:${port}/acme/assets`)!, "gho_login");
      expect(await client.session()).toEqual({ token: "r2lfs-s1.x", expiresAt: new Date("2026-09-14T01:00:00.000Z") });
      expect(seen[0]?.authorization).toBe(`Basic ${Buffer.from("r2-lfs:gho_login").toString("base64")}`);
      expect(await new HttpLfsClient(parseLfsUrl(`http://127.0.0.1:${port}/acme/old`)!, "gho_login").session()).toBeUndefined();
      expect(await new HttpLfsClient(parseLfsUrl(`http://127.0.0.1:${port}/acme/assets`)!, undefined).session()).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe("ServerStorage", () => {
  it("pages through listings, sends changes ten at a time and explains refusals", async () => {
    const requests: { method?: string; url?: string; body: string }[] = [];
    const oids = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(64, "0"));
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        requests.push({ method: req.method, url: req.url, body });
        const url = new URL(req.url ?? "", "http://x");
        if (url.pathname === "/acme/old/r2-lfs/objects") return void res.writeHead(404).end("");
        if (url.pathname === "/acme/denied/r2-lfs/objects/trash") {
          return void res.writeHead(403).end(JSON.stringify({ message: "You do not have admin access to this repository" }));
        }
        if (req.method === "GET") {
          const first = !url.searchParams.has("cursor");
          const page = first ? oids.slice(0, 2) : oids.slice(2, 3);
          return void res.end(
            JSON.stringify({
              objects: page.map((oid) => ({ oid, size: 5, uploaded: "2026-01-01T00:00:00.000Z", storage_class: "STANDARD" })),
              ...(first ? { cursor: "next" } : {}),
            }),
          );
        }
        const asked = (JSON.parse(body) as { oids: string[] }).oids;
        const outcome = url.pathname.endsWith("/trash") ? "trashed" : url.pathname.endsWith("/restore") ? "restored" : "tiered";
        res.end(JSON.stringify({ results: asked.map((oid, i) => ({ oid, outcome: i === 0 ? "locked" : outcome })) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const storage = new ServerStorage(parseLfsUrl(`http://127.0.0.1:${port}/acme/assets`)!, "admin-token");
      const live = await storage.list("acme/assets/");
      expect(live.map((o) => o.key)).toEqual(oids.slice(0, 3).map((oid) => `acme/assets/${oid}`));
      expect(requests.map((r) => r.url)).toEqual([
        "/acme/assets/r2-lfs/objects?in=live",
        "/acme/assets/r2-lfs/objects?in=live&cursor=next",
      ]);
      await storage.list("_trash/acme/assets/");
      expect(requests.at(-2)?.url).toBe("/acme/assets/r2-lfs/objects?in=trash");

      requests.length = 0;
      const objects = oids.map((oid) => ({ key: `acme/assets/${oid}`, size: 5, lastModified: new Date(), storageClass: "STANDARD" }));
      let progressed = 0;
      const outcomes = await storage.trash(objects, (done) => (progressed += done));
      expect(requests.map((r) => (JSON.parse(r.body) as { oids: string[] }).oids.length)).toEqual([10, 2]);
      expect(progressed).toBe(12);
      expect(outcomes[0]).toEqual({ key: objects[0]!.key, action: "locked", ok: true });
      expect(outcomes[1]).toEqual({ key: objects[1]!.key, action: "trashed", ok: true });
      const restored = await storage.restore(
        objects.slice(1, 2).map((o) => ({ ...o, key: `_trash/${o.key}` })),
        () => {},
      );
      expect(restored).toEqual([{ key: `_trash/${objects[1]!.key}`, ok: false, message: "locked" }]);
      await expect(storage.delete()).rejects.toThrow(/--no-trash needs the R2_\* variables/);

      const old = new ServerStorage(parseLfsUrl(`http://127.0.0.1:${port}/acme/old`)!, "t");
      await expect(old.list("acme/old/")).rejects.toThrow(/upgrade the server, or set the R2_\* variables/);
      const denied = new ServerStorage(parseLfsUrl(`http://127.0.0.1:${port}/acme/denied`)!, "t");
      await expect(denied.trash(objects.slice(0, 1), () => {})).rejects.toThrow(/403: You do not have admin access/);
    } finally {
      server.close();
    }
  });
});

describe("FileSessionCache", () => {
  it("keeps one token per repository, whatever the case, and forgets it on delete", () => {
    const dir = mkdtempSync(join(tmpdir(), "r2-lfs-sessions-"));
    try {
      const cache = new FileSessionCache(dir);
      const location = parseLfsUrl("https://lfs.example.com:8443/Acme/Assets")!;
      expect(cache.get(location)).toBeUndefined();
      const session = { token: "r2lfs-s1.x", expiresAt: new Date("2026-09-14T01:00:00Z") };
      cache.set(location, session);
      expect(cache.get(parseLfsUrl("https://lfs.example.com:8443/acme/assets.git/info/lfs")!)).toEqual(session);
      expect(readFileSync(join(dir, "lfs.example.com_8443", "acme", "assets.json"), "utf8")).toContain("r2lfs-s1.x");
      cache.delete(location);
      expect(cache.get(location)).toBeUndefined();
      writeFileSync(join(dir, "lfs.example.com_8443", "acme", "assets.json"), "not json");
      expect(cache.get(location)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("transfer agent adapters", () => {
  it("calls the multipart endpoints under the action's href with its headers", async () => {
    const seen: { method: string; url: string; auth: string | undefined; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString(),
        });
        const json = (status: number, body: unknown) =>
          res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
        if (req.url === "/o/multipart") return json(200, { uploadId: "id/+=", partSize: 5 });
        if (req.url === "/o/multipart/id%2F%2B%3D/1") return json(200, { partNumber: 1, etag: "e1" });
        if (req.url === "/o/multipart/id%2F%2B%3D/2") return json(404, { message: "No such upload" });
        if (req.url === "/o/multipart/id%2F%2B%3D/3") return json(503, { message: "busy" });
        return json(422, { message: "does not match" });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const action = { href: `http://127.0.0.1:${port}/o/multipart`, header: { Authorization: "Basic abc" } };
      const uploads = new HttpMultipartUploads();
      expect(await uploads.start(action, 12)).toEqual({ uploadId: "id/+=", partSize: 5 });
      expect(await uploads.uploadPart(action, "id/+=", 1, new TextEncoder().encode("hello"))).toEqual({ partNumber: 1, etag: "e1" });
      expect(await uploads.uploadPart(action, "id/+=", 2, new Uint8Array(1))).toBeUndefined();
      await expect(uploads.uploadPart(action, "id/+=", 3, new Uint8Array(1))).rejects.toMatchObject({ status: 503, message: "busy" });
      const refused = await uploads.complete(action, "id/+=", 12, [{ partNumber: 1, etag: "e1" }]).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(TransferError);
      expect(refused).toMatchObject({ status: 422, message: "does not match" });

      expect(seen[0]).toEqual({ method: "POST", url: "/o/multipart", auth: "Basic abc", body: '{"size":12}' });
      expect(seen[1]).toMatchObject({ method: "PUT", body: "hello" });
      expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/o/multipart/id%2F%2B%3D/complete" });
    } finally {
      server.closeAllConnections();
      server.close();
    }
    // Nothing listening any more: a TransferError without a status, which the agent retries.
    await new Promise((resolve) => server.once("close", resolve));
    await expect(new HttpMultipartUploads().start({ href: `http://127.0.0.1:${port}/gone` }, 1)).rejects.toMatchObject({
      status: undefined,
    });
  });

  it("remembers uploads per object and reads exact byte ranges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r2-lfs-states-"));
    try {
      const states = FileUploadStates.inGitDir(dir);
      const state = { href: "https://x/o/multipart", size: 10, uploadId: "u", partSize: 5, parts: [{ partNumber: 1, etag: "e" }] };
      expect(states.load("a".repeat(64))).toBeUndefined();
      states.save("a".repeat(64), state);
      expect(states.load("a".repeat(64))).toEqual(state);
      expect(readFileSync(join(dir, "lfs", "r2-lfs", "uploads", `${"a".repeat(64)}.json`), "utf8")).toContain('"uploadId":"u"');
      states.remove("a".repeat(64));
      states.remove("a".repeat(64));
      expect(states.load("a".repeat(64))).toBeUndefined();

      const file = join(dir, "data.bin");
      writeFileSync(file, "0123456789");
      expect(new TextDecoder().decode(await readFileRange(file, 5, 5))).toBe("56789");
      await expect(readFileRange(file, 8, 5)).rejects.toThrow(/ended before/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const whoami = (accounts: { id: string; name: string }[]) => JSON.stringify({ loggedIn: true, email: "me@example.com", accounts });

describe("transfer agent launcher", () => {
  const windows = process.platform === "win32";
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "r2-lfs-launcher-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Runs the launcher the way git-lfs does, with only the given directories on PATH.
  const start = (launcher: string, path: string[]) => {
    const system = windows ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : [];
    const env = { ...process.env, PATH: [...path, ...system].join(windows ? ";" : ":") };
    const [cmd, args] = windows ? ["cmd.exe", ["/d", "/c", launcher]] : [launcher, []];
    try {
      return { code: 0, out: execFileSync(cmd, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
    } catch (err) {
      const failed = err as { status: number; stderr: string };
      return { code: failed.status, out: String(failed.stderr).trim() };
    }
  };

  it("prefers r2-lfs on PATH, falls back to the Node it was installed with, and says what to do when both are gone", () => {
    const files = new LocalFiles();
    const bin = join(dir, "bin dir");
    mkdirSync(bin);
    const cli = join(dir, "it's 100% cli.js");
    writeFileSync(cli, 'console.log("fallback " + process.argv.slice(2).join(" "));\n');
    const launcher = join(dir, launcherFileName(process.platform));
    files.writeExecutable(launcher, launcherScript(process.platform, { node: process.execPath, cli }));

    expect(start(launcher, [])).toEqual({ code: 0, out: "fallback transfer-agent" });

    // A version manager's shim that is on PATH but fails, as mise's does outside a configured directory.
    const broken = join(dir, "broken shim");
    mkdirSync(broken);
    if (windows) writeFileSync(join(broken, "r2-lfs.cmd"), "@exit /b 1\r\n");
    else files.writeExecutable(join(broken, "r2-lfs"), "#!/bin/sh\nexit 1\n");
    expect(start(launcher, [broken])).toEqual({ code: 0, out: "fallback transfer-agent" });

    if (windows) writeFileSync(join(bin, "r2-lfs.cmd"), "@echo on path %*\r\n");
    else files.writeExecutable(join(bin, "r2-lfs"), '#!/bin/sh\necho "on path $*"\n');
    expect(start(launcher, [bin])).toEqual({ code: 0, out: "on path transfer-agent" });

    files.writeExecutable(launcher, launcherScript(process.platform, { node: join(dir, "gone", "node"), cli }));
    const gone = start(launcher, []);
    expect(gone.code).toBe(1);
    expect(gone.out).toContain("r2-lfs transfer-agent --install");
  });

  // git runs credential helpers with its own sh; Windows runners have no sh on PATH, and ken109-windows was checked by hand.
  it.skipIf(windows)("answers git through r2-lfs when it can, and with the gh login when r2-lfs is gone", () => {
    const files = new LocalFiles();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const launcher = join(dir, "credential");
    const answer = (path: string[]) =>
      execFileSync("sh", [launcher, "get"], {
        env: { ...process.env, PATH: [...path, "/usr/bin", "/bin"].join(":") },
        encoding: "utf8",
        input: "protocol=https\nhost=lfs.example.com\n\n",
      });
    files.writeExecutable(launcher, credentialLauncherScript({ node: join(dir, "gone", "node"), cli: join(dir, "gone", "cli.js") }));
    expect(answer([])).toBe("");
    files.writeExecutable(join(bin, "gh"), '#!/bin/sh\n[ "$1 $2" = "auth token" ] && echo gho_login\n');
    expect(answer([bin])).toBe("username=r2-lfs\npassword=gho_login\n");
    files.writeExecutable(join(bin, "r2-lfs"), "#!/bin/sh\nexit 1\n");
    expect(answer([bin])).toBe("username=r2-lfs\npassword=gho_login\n");
    files.writeExecutable(join(bin, "r2-lfs"), '#!/bin/sh\necho "username=r2-lfs"; echo "password=from-r2-lfs-$1-$2"\n');
    expect(answer([bin])).toBe("username=r2-lfs\npassword=from-r2-lfs-credential-get\n");
  });

  it("finds commands on PATH as a shell would", () => {
    const files = new LocalFiles();
    const first = join(dir, "first");
    const second = join(dir, "second");
    mkdirSync(first);
    mkdirSync(second);
    files.writeExecutable(join(second, "tool"), "");
    writeFileSync(join(first, "tool.CMD"), "");
    expect(findOnPath("tool", { Path: [first, second].join(";"), PATHEXT: ".EXE;.CMD" }, "win32")).toBe(join(first, "tool.CMD"));
  });

  // A Windows drive letter would split a colon-separated PATH, so this runs elsewhere.
  it.skipIf(windows)("splits PATH on colons outside Windows", () => {
    const first = join(dir, "first");
    const second = join(dir, "second");
    mkdirSync(first);
    mkdirSync(second);
    new LocalFiles().writeExecutable(join(second, "tool"), "");
    expect(findOnPath("tool", { PATH: [first, second].join(":") }, "linux")).toBe(join(second, "tool"));
    expect(findOnPath("missing", { PATH: first }, "linux")).toBeUndefined();
  });
});

describe("parseWhoami", () => {
  it("takes the account from CLOUDFLARE_ACCOUNT_ID, or the only account the login has", () => {
    const one = whoami([{ id: "acc1", name: "me" }]);
    const two = whoami([
      { id: "acc1", name: "me" },
      { id: "acc2", name: "team" },
    ]);
    expect(parseWhoami(one, {})).toEqual({ email: "me@example.com", accountId: "acc1" });
    expect(parseWhoami(two, {})).toEqual({ email: "me@example.com", accountId: undefined });
    expect(parseWhoami(two, { CLOUDFLARE_ACCOUNT_ID: "acc2" })).toEqual({ email: "me@example.com", accountId: "acc2" });
  });

  it("reports no login for output it cannot read", () => {
    expect(parseWhoami(JSON.stringify({ loggedIn: false }), {})).toBeUndefined();
    expect(parseWhoami("You are not authenticated", {})).toBeUndefined();
  });
});

describe("TarWriter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "r2-lfs-tar-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function extract(archive: string): string {
    const target = join(dir, "x");
    mkdirSync(target);
    execFileSync("tar", ["-xf", archive, "-C", target]);
    return target;
  }

  it("writes archives the system tar reads, including names longer than 100 bytes", async () => {
    const source = join(dir, "source.bin");
    writeFileSync(source, Buffer.alloc(1500, 7));
    const longName = `${"nested/".repeat(20)}日本語のファイル.blend`;
    const archive = join(dir, "out.tar");
    const writer = new TarWriter(archive);
    await writer.add({ name: longName, size: 1500, mode: 0o644, source: { kind: "file", path: source } });
    await writer.add({ name: "readme.txt", size: 5, mode: 0o644, source: { kind: "buffer", data: new TextEncoder().encode("hello") } });
    await writer.close();

    // Compare extracted files, not `tar -t` output: Windows consoles re-encode non-ASCII names.
    const out = extract(archive);
    expect(readFileSync(join(out, "readme.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(out, longName))).toEqual(Buffer.alloc(1500, 7));
  });

  // Extracting symlinks needs extra privileges on Windows.
  it.skipIf(process.platform === "win32")("writes symlinks", async () => {
    const archive = join(dir, "links.tar");
    const writer = new TarWriter(archive);
    await writer.add({ name: "readme.txt", size: 5, mode: 0o644, source: { kind: "buffer", data: new TextEncoder().encode("hello") } });
    await writer.add({ name: "link", size: 0, mode: 0o777, source: { kind: "symlink", target: "readme.txt" } });
    await writer.close();
    expect(readFileSync(join(extract(archive), "link"), "utf8")).toBe("hello");
  });
});
