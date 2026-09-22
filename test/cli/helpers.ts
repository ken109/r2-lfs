import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach } from "vitest";

import {
  type BatchObject,
  type Bucket,
  type BucketObject,
  ConflictError,
  type Files,
  type GitHubCli,
  type GitRepository,
  type GlobalGitConfig,
  type InfoResult,
  type LfsClient,
  type ObjectStorage,
  type Outcome,
  type Progress,
  type Reporter,
  type RestoredObject,
  type Session,
  type SessionCache,
  type StorageSupport,
  type Wrangler,
  type WriteResult,
} from "../../cli/app/ports.ts";
import type { ObjectRef, StoredObject } from "../../cli/domain/objects.ts";
import { type LfsLocation, parseLfsUrl } from "../../cli/domain/remote.ts";
import { BucketStorage } from "../../cli/infra/bucket-storage.ts";
import { Git } from "../../cli/infra/git.ts";
import { repoPrefix, type ServerInfo, type StorageLayout, TRASH_PREFIX } from "../../src/shared/contract.ts";

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

/** The moment `daysAgo` days before now. */
export const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS);

/** The text of an LFS pointer file, as git-lfs writes it. */
export const pointerText = (oid: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

/** A listed object of one byte, uploaded now. */
export const storedObject = (key: string): StoredObject => ({ key, size: 1, lastModified: new Date(), storageClass: "STANDARD" });

/** Runs the queued clean-ups after each test of the file that calls this. */
export function cleanups(): (...fns: (() => void)[]) => void {
  let queued: (() => void)[] = [];
  afterEach(() => {
    for (const fn of queued) fn();
    queued = [];
  });
  return (...fns) => void queued.push(...fns);
}

export function oidOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** An in-memory bucket that behaves like R2 for the operations the CLI uses. */
export class MemoryBucket implements Bucket {
  readonly name = "test-bucket";
  encrypted = false;
  readonly objects = new Map<string, { body: string; size: number; lastModified: Date; storageClass: string; etag: string }>();
  /** Keys under these prefixes refuse deletion, like a bucket lock rule. */
  readonly locked: string[] = [];
  /** Prefixes whose deletes fail with a 403 that is not a bucket lock. */
  readonly forbidden: string[] = [];
  /** Keys whose deletion goes through but reports an error, like a response lost to a timeout. */
  readonly deletesThatTimeOut = new Set<string>();
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
    if (opts.expectEtag === null && existing) throw new ConflictError(`${key} already exists`);
    if (typeof opts.expectEtag === "string" && existing?.etag !== opts.expectEtag) throw new ConflictError(`${key} changed`);
    this.seed(key, { body });
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async delete(key: string): Promise<WriteResult> {
    if (this.locked.some((prefix) => key.startsWith(prefix))) return { ok: false, status: 403, message: "locked", locked: true };
    if (this.forbidden.some((prefix) => key.startsWith(prefix))) return { ok: false, status: 403, message: "AccessDenied" };
    this.objects.delete(key);
    if (this.deletesThatTimeOut.has(key)) return { ok: false, status: 504, message: "timeout" };
    return { ok: true, status: 204, message: "" };
  }

  async copy(source: string, target: string, storageClass?: "STANDARD" | "STANDARD_IA"): Promise<WriteResult> {
    const object = this.objects.get(source);
    if (!object) return { ok: false, status: 404, message: "NoSuchKey" };
    if (this.objects.has(target) && this.locked.some((prefix) => target.startsWith(prefix))) {
      return { ok: false, status: 403, message: "locked", locked: true };
    }
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

/** The repository `FakeLfsClient` points at, whose objects the storage fakes list. */
export const REPOSITORY = { owner: "acme", repo: "assets" };

/** What the server's storage endpoints allow. */
export const THROUGH_SERVER: StorageSupport = { sharedLayout: false, deleteWithoutTrash: false, encryptedObjects: true };

/**
 * The storage port in memory, without the bucket's copy-then-delete steps: what gc and restore see through either
 * adapter. Objects are keyed like the bucket, trashed ones under the trash prefix.
 */
export class MemoryObjectStorage implements ObjectStorage {
  readonly name = "memory";
  /** Everything, as with the bucket directly; `THROUGH_SERVER` for what the server's endpoints allow. */
  supports: StorageSupport = { sharedLayout: true, deleteWithoutTrash: true, encryptedObjects: true };
  readonly objects = new Map<string, StoredObject>();
  /** Keys whose changes a bucket lock rule refuses. */
  readonly locked = new Set<string>();

  seed(key: string, opts: { size?: number; ageDays?: number; storageClass?: string } = {}): void {
    this.objects.set(key, {
      key,
      size: opts.size ?? 1,
      lastModified: at(opts.ageDays ?? 0),
      storageClass: opts.storageClass ?? "STANDARD",
    });
  }

  async list(where: "live" | "trash", layout: StorageLayout): Promise<StoredObject[]> {
    const live = repoPrefix(layout, REPOSITORY.owner, REPOSITORY.repo);
    const prefix = where === "live" ? live : `${TRASH_PREFIX}${live}`;
    return [...this.objects.values()].filter((o) => o.key.startsWith(prefix));
  }

  private move(from: string, to: string): boolean {
    const object = this.objects.get(from);
    if (!object) return false;
    this.objects.delete(from);
    this.objects.set(to, { ...object, key: to });
    return true;
  }

  private each<T>(objects: readonly StoredObject[], progress: (done: number) => void, act: (key: string) => T): T[] {
    return objects.map(({ key }) => {
      const result = act(key);
      progress(1);
      return result;
    });
  }

  async trash(objects: readonly StoredObject[], progress: (done: number) => void): Promise<Outcome[]> {
    return this.each(objects, progress, (key): Outcome => {
      if (this.locked.has(key)) return { key, action: "locked", ok: true };
      return this.move(key, `${TRASH_PREFIX}${key}`)
        ? { key, action: "trashed", ok: true }
        : { key, action: "trash", ok: false, message: "missing" };
    });
  }

  async delete(objects: readonly StoredObject[], progress: (done: number) => void): Promise<Outcome[]> {
    return this.each(objects, progress, (key): Outcome => {
      if (this.locked.has(key)) return { key, action: "locked", ok: true };
      return this.objects.delete(key) ? { key, action: "deleted", ok: true } : { key, action: "delete", ok: false, message: "missing" };
    });
  }

  async tier(objects: readonly StoredObject[], progress: (done: number) => void): Promise<Outcome[]> {
    return this.each(objects, progress, (key): Outcome => {
      const object = this.objects.get(key);
      if (!object) return { key, action: "tier", ok: false, message: "missing" };
      if (this.locked.has(key)) return { key, action: "locked", ok: true };
      object.storageClass = "STANDARD_IA";
      return { key, action: "tiered", ok: true };
    });
  }

  async restore(objects: readonly StoredObject[], progress: (done: number) => void): Promise<RestoredObject[]> {
    return this.each(objects, progress, (key) =>
      this.move(key, key.slice(TRASH_PREFIX.length)) ? { key, ok: true } : { key, ok: false, message: "missing" },
    );
  }
}

/** A server that has exactly the objects in `stored`. */
export class FakeLfsClient implements LfsClient {
  readonly location = parseLfsUrl("https://lfs.example.com/acme/assets")!;
  hasCredentials = true;
  serverInfo: ServerInfo = { ...SERVER_INFO };
  readonly stored = new Map<string, string>();

  async info(): Promise<InfoResult> {
    return { kind: "ok", info: this.serverInfo };
  }

  /** What the session endpoint answers; undefined like a server without one. */
  sessionAnswer: Session | undefined;

  async session(): Promise<Session | undefined> {
    return this.sessionAnswer;
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

  /** A new repository, or a clone of `source` made with `cloneArgs` such as `--depth 1`. */
  constructor(source?: TempRepo, ...cloneArgs: string[]) {
    this.dir = mkdtempSync(join(tmpdir(), "r2-lfs-test-"));
    if (source) execFileSync("git", ["clone", "-q", ...cloneArgs, pathToFileURL(source.dir).href, this.dir]);
    else this.git("init", "-q", "-b", "main");
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
    this.write(path, pointerText(oid, content.length));
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

export class FakeGitConfig implements GlobalGitConfig {
  readonly values = new Map<string, string>();
  ghOrigins: string[] = [];
  token: string | undefined = "secret";
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
  helpersFor(_origin: string): string[] {
    return [];
  }
  useGhCredentials(origin: string) {
    this.ghOrigins.push(origin);
  }
  useCredentialHelper(_origin: string, _helper: string) {}
  credentialFor() {
    return this.token;
  }
}

export class MemorySessionCache implements SessionCache {
  readonly sessions = new Map<string, Session>();
  get(location: LfsLocation) {
    return this.sessions.get(`${location.owner}/${location.repo}`);
  }
  set(location: LfsLocation, session: Session) {
    this.sessions.set(`${location.owner}/${location.repo}`, session);
  }
  delete(location: LfsLocation) {
    this.sessions.delete(`${location.owner}/${location.repo}`);
  }
}

/** A machine without the GitHub CLI. */
export const noGh: GitHubCli = {
  available: () => false,
  loggedIn: () => false,
  token: () => undefined,
  releaseState: () => undefined,
  createDraftRelease: () => {},
  uploadAssets: async () => 0,
  publishRelease: () => {},
};

/** Local files that only record what was written and copied. */
export class RecordingFiles implements Files {
  readonly written = new Map<string, string>();
  readonly copied: string[] = [];
  private readonly temp: string;

  constructor(temp = "/tmp/with space/r2-lfs-setup-1") {
    this.temp = temp;
  }

  sizeOf() {
    return undefined;
  }
  readText() {
    return undefined;
  }
  writeExecutable() {}
  mkdirp() {}
  writeText(path: string, text: string) {
    this.written.set(path, text);
  }
  copyFile() {}
  copyDir(from: string, to: string) {
    this.copied.push(`${from} -> ${to}`);
  }
  async sha256() {
    return "";
  }
  async writeTar() {}
  tempDir() {
    return this.temp;
  }
}

/** Wrangler logged in to one account, where the bucket already exists and deploys succeed. */
export class FakeWrangler implements Wrangler {
  readonly runs: { args: string[]; cwd?: string }[] = [];

  whoami() {
    return { email: "me@example.com", accountId: "acc123" };
  }

  run(args: string[], opts?: { input?: string; cwd?: string }) {
    this.runs.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    if (args[0] === "r2" && args[2] === "create") return { code: 1, output: "The bucket already exists" };
    return { code: 0, output: args[0] === "deploy" ? "Deployed https://r2-lfs.me.workers.dev" : "" };
  }
}

/** A repository with an old version, a current version and an orphan in the bucket. */
export function scenario() {
  const repo = new TempRepo();
  const oldOid = repo.writeLfs("hero.blend", "hero v1");
  repo.commit("v1", 200);
  const newOid = repo.writeLfs("hero.blend", "hero v2");
  const texOid = repo.writeLfs("tex/wood.png", "wood");
  repo.commit("v2", 1);

  const bucket = new MemoryBucket();
  const prefix = "acme/assets/";
  bucket.seed(`${prefix}${oldOid}`, { size: 7, ageDays: 200 });
  bucket.seed(`${prefix}${newOid}`, { size: 7, ageDays: 1 });
  bucket.seed(`${prefix}${texOid}`, { size: 4, ageDays: 1 });
  const orphan = "e".repeat(64);
  bucket.seed(`${prefix}${orphan}`, { size: 3, ageDays: 400 });
  const youngOrphan = "f".repeat(64);
  bucket.seed(`${prefix}${youngOrphan}`, { size: 3, ageDays: 2 });

  const client = new FakeLfsClient();
  for (const oid of [newOid, texOid, oldOid]) client.stored.set(oid, "x");
  return { repo, git: Git.open(repo.dir), bucket, client, oldOid, newOid, texOid, orphan, youngOrphan, prefix };
}

export type Scenario = ReturnType<typeof scenario>;

export interface ScenarioDeps {
  repo: GitRepository;
  otherRepos: GitRepository[];
  client: FakeLfsClient;
  storage: ObjectStorage;
  reporter: SilentReporter;
}

/** What gc, restore and the reports take for a scenario: its repository, server and bucket, with any of it replaced. */
export function scenarioDeps(s: Scenario, over: Partial<ScenarioDeps> = {}): ScenarioDeps {
  return {
    repo: s.git,
    otherRepos: [],
    client: s.client,
    storage: new BucketStorage(s.bucket, REPOSITORY),
    reporter: new SilentReporter(),
    ...over,
  };
}
