import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "../../cli/app/ports.ts";
import { parseLfsUrl } from "../../cli/domain/remote.ts";
import { GithubActionsIdTokens } from "../../cli/infra/actions-id-token.ts";
import { Git } from "../../cli/infra/git.ts";
import { HttpLfsClient } from "../../cli/infra/lfs-client.ts";
import { parseListObjects, R2Bucket, ssecHeaders } from "../../cli/infra/r2-bucket.ts";
import { TarWriter } from "../../cli/infra/tar-writer.ts";
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
            res.writeHead(403).end("<Error><Code>AccessDenied</Code><Message>Object is locked</Message></Error>");
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
    expect(await bucket.delete("locked/y")).toMatchObject({ ok: false, status: 403, message: "Object is locked" });
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
