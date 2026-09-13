import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BatchObject, Bucket, BucketObject, InfoResult, LfsClient, Progress, Reporter, WriteResult } from "../../cli/app/ports.ts";
import type { ObjectRef, StoredObject } from "../../cli/domain/objects.ts";
import { parseLfsUrl } from "../../cli/domain/remote.ts";
import type { ServerInfo } from "../../src/shared/contract.ts";

export class SilentReporter implements Reporter {
  readonly warnings: string[] = [];
  step(): void {}
  info(): void {}
  success(): void {}
  warn(message: string): void {
    this.warnings.push(message);
  }
  async task<T>(_label: string, work: () => T | Promise<T>): Promise<T> {
    return work();
  }
  progress(): Progress {
    return { advance: () => {}, stop: () => {} };
  }
}

export const DAY_MS = 86_400_000;

export function oidOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** An in-memory bucket that behaves like R2 for the operations the CLI uses. */
export class MemoryBucket implements Bucket {
  readonly name = "test-bucket";
  readonly objects = new Map<string, { body: string; size: number; lastModified: Date; storageClass: string; etag: string }>();
  /** Keys under these prefixes refuse deletion, like a bucket lock rule. */
  readonly locked: string[] = [];
  private etagCounter = 0;

  seed(key: string, opts: { size?: number; ageDays?: number; body?: string; storageClass?: string } = {}): void {
    const body = opts.body ?? "";
    this.objects.set(key, {
      body,
      size: opts.size ?? body.length,
      lastModified: new Date(Date.now() - (opts.ageDays ?? 0) * DAY_MS),
      storageClass: opts.storageClass ?? "STANDARD",
      etag: `"${++this.etagCounter}"`,
    });
  }

  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, o]) => ({ key, size: o.size, lastModified: o.lastModified, storageClass: o.storageClass }));
  }

  async get(key: string): Promise<BucketObject | undefined> {
    const object = this.objects.get(key);
    return object ? { text: async () => object.body, etag: object.etag } : undefined;
  }

  async put(key: string, body: string, opts: { expectEtag?: string | null } = {}): Promise<void> {
    const existing = this.objects.get(key);
    if (opts.expectEtag === null && existing) throw new Error("precondition failed");
    if (typeof opts.expectEtag === "string" && existing?.etag !== opts.expectEtag) throw new Error("precondition failed");
    this.seed(key, { body });
  }

  async delete(key: string): Promise<WriteResult> {
    if (this.locked.some((prefix) => key.startsWith(prefix))) return { ok: false, status: 403, message: "locked" };
    this.objects.delete(key);
    return { ok: true, status: 204, message: "" };
  }

  async copy(source: string, target: string, storageClass?: "STANDARD" | "STANDARD_IA"): Promise<WriteResult> {
    const object = this.objects.get(source);
    if (!object) return { ok: false, status: 404, message: "NoSuchKey" };
    this.objects.set(target, {
      ...object,
      storageClass: storageClass ?? object.storageClass,
      lastModified: new Date(),
      etag: `"${++this.etagCounter}"`,
    });
    return { ok: true, status: 200, message: "" };
  }
}

export const SERVER_INFO: ServerInfo = {
  name: "r2-lfs",
  version: "test",
  authMode: "github",
  storageLayout: "per-repo",
  transfer: "proxy",
  proxyMaxUploadBytes: 100 * 1024 * 1024,
};

/** A server that has exactly the objects in `stored`. */
export class FakeLfsClient implements LfsClient {
  readonly location = parseLfsUrl("https://lfs.example.com/acme/assets")!;
  hasCredentials = true;
  serverInfo: ServerInfo = { ...SERVER_INFO };
  readonly stored = new Map<string, string>();

  async info(): Promise<InfoResult> {
    return { kind: "ok", info: this.serverInfo };
  }

  async batch(_operation: "upload" | "download", objects: ObjectRef[]): Promise<BatchObject[]> {
    return objects.map((o) =>
      this.stored.has(o.oid)
        ? { ...o, actions: { download: { href: `memory://${o.oid}` } } }
        : { ...o, error: { code: 404, message: "Object does not exist" } },
    );
  }

  async download(object: BatchObject): Promise<AsyncIterable<Uint8Array>> {
    const body = this.stored.get(object.oid) ?? "";
    return (async function* () {
      yield new TextEncoder().encode(body);
    })();
  }
}

/** A throwaway repository whose LFS files are pointer files written directly, so no server is needed. */
export class TempRepo {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "r2-lfs-test-"));
    this.git("init", "-q", "-b", "main");
    this.git("config", "user.name", "Test");
    this.git("config", "user.email", "test@example.com");
    this.git("config", "commit.gpgsign", "false");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, ...args], { encoding: "utf8", env: { ...process.env, ...this.env } });
  }

  private env: Record<string, string> = {};

  write(path: string, content: string): void {
    const file = join(this.dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  /** Writes an LFS pointer for `content` at `path` and returns its oid. */
  writeLfs(path: string, content: string): string {
    const oid = oidOf(content);
    this.write(path, `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`);
    return oid;
  }

  commit(message: string, ageDays = 0): string {
    const date = new Date(Date.now() - ageDays * DAY_MS).toISOString();
    this.env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", message);
    this.env = {};
    return this.git("rev-parse", "HEAD").trim();
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
