import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diagnose } from "../../cli/app/doctor.ts";
import { applyGc, applyPlan, gcMode, planGc, recheckPlan, trashObject } from "../../cli/app/gc.ts";
import { initRepository } from "../../cli/app/init.ts";
import { migrate } from "../../cli/app/migrate.ts";
import {
  BatchRequestError,
  ConflictError,
  type Files,
  type GitHubCli,
  type GlobalGitConfig,
  type LfsClient,
  type Wrangler,
} from "../../cli/app/ports.ts";
import { listTrash, restoreObjects, selectTrash } from "../../cli/app/restore.ts";
import { setupServer } from "../../cli/app/setup.ts";
import { createToken, listTokens, revoke } from "../../cli/app/token.ts";
import { usageReport } from "../../cli/app/usage.ts";
import { verifyObjects } from "../../cli/app/verify.ts";
import { explain } from "../../cli/app/why.ts";
import { UsageError } from "../../cli/domain/errors.ts";
import { Git } from "../../cli/infra/git.ts";
import { TOKENS_KEY } from "../../src/shared/contract.ts";
import { FakeLfsClient, MemoryBucket, SilentReporter, TempRepo } from "./helpers.ts";

class FakeGitConfig implements GlobalGitConfig {
  readonly values = new Map<string, string>();
  ghOrigins: string[] = [];
  token: string | undefined = "secret";
  get(key: string) {
    return this.values.get(key);
  }
  set(key: string, value: string) {
    this.values.set(key, value);
  }
  helpersFor() {
    return [];
  }
  useGhCredentials(origin: string) {
    this.ghOrigins.push(origin);
  }
  credentialFor() {
    return this.token;
  }
}

const noGh: GitHubCli = {
  available: () => false,
  loggedIn: () => false,
  releaseState: () => undefined,
  createDraftRelease: () => {},
  uploadAssets: async () => 0,
  publishRelease: () => {},
};

/** A repository with an old version, a current version and an orphan in the bucket. */
function scenario() {
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

const object = (key: string) => ({ key, size: 1, lastModified: new Date(), storageClass: "STANDARD" });

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("gc", () => {
  it("turns the flags into a mode, so -i and --apply enable the checks a dry run skips", () => {
    expect(gcMode({})).toBe("dry-run");
    expect(gcMode({ apply: false, interactive: false })).toBe("dry-run");
    expect(gcMode({ apply: true })).toBe("apply");
    expect(gcMode({ interactive: true })).toBe("interactive");
    expect(gcMode({ apply: true, interactive: true })).toBe("interactive");
  });

  it("applies a plan only after checking the refs again", async () => {
    const s = scenario();
    const clone = new TempRepo(s.repo);
    cleanup.push(
      () => s.repo.remove(),
      () => clone.remove(),
    );
    const reporter = new SilentReporter();
    const deps = { repo: Git.open(clone.dir), otherRepos: [], client: s.client, bucket: s.bucket, reporter };
    const opts = { fetch: true, mode: gcMode({ apply: true }) };
    const plan = await planGc(deps, opts);

    s.repo.writeLfs("hero.blend", "hero v1");
    s.repo.commit("revert");
    const outcomes = await applyPlan(deps, plan, plan.candidates, { ...opts, trash: true });
    expect(outcomes.map((o) => o.key)).toEqual([`${s.prefix}${s.orphan}`]);
    expect(s.bucket.objects.has(`${s.prefix}${s.oldOid}`)).toBe(true);
  });

  it("plans from history and moves candidates to the trash", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    const reporter = new SilentReporter();
    const plan = await planGc({ repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter }, { fetch: false });

    const decisions = Object.fromEntries(plan.planned.map((p) => [p.oid, p.decision.kind]));
    expect(decisions).toEqual({
      [s.oldOid]: "delete",
      [s.newOid]: "keep",
      [s.texOid]: "keep",
      [s.orphan]: "delete",
      [s.youngOrphan]: "young",
    });

    const outcomes = await applyGc({ bucket: s.bucket, reporter }, plan.candidates, { trash: true });
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(s.bucket.objects.has(`_trash/${s.prefix}${s.oldOid}`)).toBe(true);
    expect(s.bucket.objects.has(`${s.prefix}${s.oldOid}`)).toBe(false);
  });

  it("keeps the object and drops the trash copy when a lock refuses the delete", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    s.bucket.locked.push(s.prefix);
    const reporter = new SilentReporter();
    const plan = await planGc({ repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter }, { fetch: false });
    const outcomes = await applyGc({ bucket: s.bucket, reporter }, plan.candidates, { trash: true });
    expect(outcomes.every((o) => !o.ok)).toBe(true);
    expect(s.bucket.objects.has(`${s.prefix}${s.oldOid}`)).toBe(true);
    expect([...s.bucket.objects.keys()].some((k) => k.startsWith("_trash/"))).toBe(false);
  });

  it("deletes without the trash, tiers, and reports what a lock refuses", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    s.repo.write(".r2-lfs.toml", '[[rule]]\npath = "*.blend"\nold_versions = "infrequent-access"\n');
    s.repo.commit("policy");
    const reporter = new SilentReporter();
    const plan = await planGc({ repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter }, { fetch: false });
    expect(plan.candidates.map((p) => [p.oid, p.decision.kind])).toEqual([
      [s.oldOid, "tier"],
      [s.orphan, "delete"],
    ]);

    s.bucket.locked.push(`${s.prefix}${s.orphan}`);
    const outcomes = await applyGc({ bucket: s.bucket, reporter }, plan.candidates, { trash: false });
    expect(outcomes).toEqual([
      { key: `${s.prefix}${s.oldOid}`, action: "tiered", ok: true },
      { key: `${s.prefix}${s.orphan}`, action: "delete", ok: false, message: "403 locked" },
    ]);
    expect(s.bucket.objects.get(`${s.prefix}${s.oldOid}`)?.storageClass).toBe("STANDARD_IA");

    s.bucket.locked.length = 0;
    const deleted = await applyGc({ bucket: s.bucket, reporter }, plan.candidates.slice(1), { trash: false });
    expect(deleted).toEqual([{ key: `${s.prefix}${s.orphan}`, action: "deleted", ok: true }]);
    expect([...s.bucket.objects.keys()].some((k) => k.startsWith("_trash/"))).toBe(false);
  });

  it("never loses the only copy when copying or deleting goes wrong", async () => {
    const bucket = new MemoryBucket();

    expect(await trashObject(bucket, object("acme/assets/missing"))).toMatchObject({ ok: false, message: "copy failed: 404 NoSuchKey" });

    bucket.seed("acme/assets/timeout");
    bucket.deletesThatTimeOut.add("acme/assets/timeout");
    expect(await trashObject(bucket, object("acme/assets/timeout"))).toMatchObject({ ok: true, action: "trashed" });
    expect(bucket.objects.has("_trash/acme/assets/timeout")).toBe(true);

    bucket.seed("acme/assets/unknown");
    bucket.locked.push("acme/assets/unknown");
    bucket.exists = async () => {
      throw new Error("network down");
    };
    expect(await trashObject(bucket, object("acme/assets/unknown"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("kept the trash copy"),
    });
    expect(bucket.objects.has("acme/assets/unknown")).toBe(true);
    expect(bucket.objects.has("_trash/acme/assets/unknown")).toBe(true);
  });

  it("drops candidates that commits pushed after planning need", async () => {
    const s = scenario();
    const clone = new TempRepo(s.repo);
    cleanup.push(
      () => s.repo.remove(),
      () => clone.remove(),
    );
    const reporter = new SilentReporter();
    const deps = { repo: Git.open(clone.dir), otherRepos: [], client: s.client, bucket: s.bucket, reporter };
    const opts = { fetch: true, mode: "apply" as const };
    const plan = await planGc(deps, opts);
    expect(plan.candidates.map((p) => p.oid)).toEqual([s.oldOid, s.orphan]);
    expect(await recheckPlan(deps, plan, plan.candidates, opts)).toEqual(plan.candidates);

    // Someone reverts to the old version; git-lfs does not upload it again, so its upload date stays old.
    s.repo.writeLfs("hero.blend", "hero v1");
    s.repo.commit("revert");
    const rechecked = await recheckPlan(deps, plan, plan.candidates, opts);
    expect(rechecked.map((p) => p.oid)).toEqual([s.orphan]);
    expect(reporter.warnings).toEqual([expect.stringContaining("1 object(s) are needed by commits pushed")]);
  });

  it("keeps objects of older commits inside the keep_days window of the rule for their path", async () => {
    const repo = new TempRepo();
    cleanup.push(() => repo.remove());
    repo.write(".r2-lfs.toml", 'keep_days = 30\n[[rule]]\npath = "raw/**"\nkeep_days = 7\n');
    const rawTenDays = repo.writeLfs("raw/take.wav", "take from 10 days ago");
    const texTenDays = repo.writeLfs("tex/wood.png", "wood from 10 days ago");
    repo.commit("ten days ago", 10);
    const rawThreeDays = repo.writeLfs("raw/take.wav", "take from 3 days ago");
    repo.commit("three days ago", 3);
    repo.writeLfs("raw/take.wav", "take now");
    repo.writeLfs("tex/wood.png", "wood now");
    repo.commit("now");

    const bucket = new MemoryBucket();
    for (const oid of [rawTenDays, texTenDays, rawThreeDays]) bucket.seed(`acme/assets/${oid}`, { ageDays: 400 });
    const plan = await planGc(
      { repo: Git.open(repo.dir), otherRepos: [], client: new FakeLfsClient(), bucket, reporter: new SilentReporter() },
      { fetch: false },
    );
    expect(Object.fromEntries(plan.planned.map((p) => [p.oid, p.decision]))).toEqual({
      [rawTenDays]: { kind: "delete" },
      [texTenDays]: { kind: "keep", reason: "tex/wood.png: used in the last 30 days" },
      [rawThreeDays]: { kind: "keep", reason: "raw/take.wav: used in the last 7 days" },
    });
  });

  it("honours .r2-lfs.toml and command-line overrides", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    s.repo.write(".r2-lfs.toml", '[[rule]]\npath = "*.blend"\nkeep_versions = 2\n');
    s.repo.commit("policy");
    const reporter = new SilentReporter();
    const deps = { repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter };
    const byPolicy = await planGc(deps, { fetch: false });
    expect(byPolicy.planned.find((p) => p.oid === s.oldOid)?.decision.kind).toBe("keep");

    const overridden = await planGc(deps, { fetch: false, minAgeDays: "0" });
    expect(overridden.planned.find((p) => p.oid === s.youngOrphan)?.decision.kind).toBe("delete");
    await expect(planGc(deps, { fetch: false, keepDays: "-1" })).rejects.toThrow(UsageError);
  });

  it("refuses clones with incomplete history, and stops on a failed fetch unless it only reports", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    const reporter = new SilentReporter();
    const shallow = new TempRepo(s.repo, "--depth", "1");
    cleanup.push(() => shallow.remove());
    const deps = (repo: Git) => ({ repo, otherRepos: [], client: s.client, bucket: s.bucket, reporter });
    await expect(planGc(deps(Git.open(shallow.dir)), { fetch: false })).rejects.toThrow(/full history/);

    s.repo.git("remote", "add", "origin", join(s.repo.dir, "does-not-exist"));
    await expect(planGc(deps(s.git), { fetch: true, mode: "apply" })).rejects.toThrow(/git fetch failed/);
    await expect(planGc(deps(s.git), { fetch: true, mode: "interactive" })).rejects.toThrow(/git fetch failed/);
    await planGc(deps(s.git), { fetch: true });
    expect(reporter.warnings).toEqual([expect.stringContaining("git fetch failed")]);
  });

  it("flags the shared layout without other repositories and refuses to apply without picking", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    s.client.serverInfo.storageLayout = "shared";
    const deps = { repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter: new SilentReporter() };
    const plan = await planGc(deps, { fetch: false });
    expect(plan.sharedWithoutRepos).toBe(true);
    expect(plan.prefix).toBe("_shared/");
    await expect(planGc(deps, { fetch: false, mode: "apply" })).rejects.toThrow(/without --repos/);
    expect((await planGc(deps, { fetch: false, mode: "interactive" })).sharedWithoutRepos).toBe(true);
  });

  it("judges each repository in the shared layout by its own policy", async () => {
    const s = scenario();
    const other = new TempRepo();
    cleanup.push(
      () => s.repo.remove(),
      () => other.remove(),
    );
    other.write(".r2-lfs.toml", '[[rule]]\npath = "final/**"\nkeep = "all"\n');
    const finalOld = other.writeLfs("final/cut.exr", "cut v1");
    other.commit("v1", 300);
    const finalNew = other.writeLfs("final/cut.exr", "cut v2");
    other.commit("v2", 200);

    s.client.serverInfo.storageLayout = "shared";
    const bucket = new MemoryBucket();
    for (const oid of [s.oldOid, s.newOid, finalOld, finalNew, s.orphan]) bucket.seed(`_shared/${oid}`, { size: 5, ageDays: 400 });
    const reporter = new SilentReporter();
    const deps = { repo: s.git, otherRepos: [Git.open(other.dir)], client: s.client, bucket, reporter };

    const plan = await planGc(deps, { fetch: false, mode: "apply" });
    expect(Object.fromEntries(plan.planned.map((p) => [p.oid, p.decision.kind]))).toEqual({
      [s.oldOid]: "delete",
      [s.newOid]: "keep",
      [finalOld]: "keep",
      [finalNew]: "keep",
      [s.orphan]: "delete",
    });

    const perRepo = { ...deps, client: new FakeLfsClient() };
    await expect(planGc(perRepo, { fetch: false })).rejects.toThrow(/only applies to the shared layout/);
  });
});

describe("restore", () => {
  it("lists, selects by oid prefix and path, and restores", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    const reporter = new SilentReporter();
    await s.bucket.copy(`${s.prefix}${s.oldOid}`, `_trash/${s.prefix}${s.oldOid}`);
    await s.bucket.delete(`${s.prefix}${s.oldOid}`);

    const deps = { repo: s.git, client: s.client, bucket: s.bucket, reporter };
    const trash = await listTrash(deps);
    expect(trash.map((t) => [t.oid, t.paths])).toEqual([[s.oldOid, ["hero.blend"]]]);
    expect(selectTrash(trash, { kind: "path", path: "hero.blend" })).toHaveLength(1);
    expect(() => selectTrash(trash, { kind: "oids", prefixes: ["zzz"] })).toThrow(/nothing in the trash/);

    const outcomes = await restoreObjects(
      { bucket: s.bucket, reporter },
      selectTrash(trash, { kind: "oids", prefixes: [s.oldOid.slice(0, 8)] }),
    );
    expect(outcomes).toEqual([{ oid: s.oldOid, ok: true }]);
    expect(s.bucket.objects.has(`${s.prefix}${s.oldOid}`)).toBe(true);
    expect(s.bucket.objects.has(`_trash/${s.prefix}${s.oldOid}`)).toBe(false);
  });
});

describe("tokens", () => {
  it("creates, lists and revokes without storing the token", async () => {
    const bucket = new MemoryBucket();
    const { token, entry } = await createToken(bucket, { label: "laptop", scope: "acme/*", readOnly: false });
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
    await createToken(bucket, { label: "laptop", scope: "acme/*", readOnly: false });
    const read = bucket.get.bind(bucket);
    const racing = async (key: string) => {
      const current = await read(key);
      await bucket.put(key, JSON.stringify({ version: 1, tokens: [] }));
      bucket.get = read;
      return current;
    };

    bucket.get = racing;
    await expect(createToken(bucket, { label: "ci", scope: "acme/*", readOnly: true })).rejects.toBeInstanceOf(ConflictError);
    await createToken(bucket, { label: "desk", scope: "acme/*", readOnly: true });
    bucket.get = racing;
    await expect(revoke(bucket, "desk")).rejects.toBeInstanceOf(ConflictError);

    const empty = new MemoryBucket();
    empty.get = async (key) => {
      await empty.put(key, JSON.stringify({ version: 1, tokens: [] }));
      return undefined;
    };
    await expect(createToken(empty, { label: "first", scope: "*", readOnly: true })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("verify, usage and why", () => {
  it("reports what the server is missing and whether it is in the trash", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    s.client.stored.delete(s.newOid);
    await s.bucket.copy(`${s.prefix}${s.newOid}`, `_trash/${s.prefix}${s.newOid}`);
    const result = await verifyObjects(
      { repo: s.git, client: s.client, reporter: new SilentReporter(), bucket: s.bucket },
      { all: false, deep: true },
    );
    expect(result.checked).toBe(2);
    expect(result.missing).toEqual([{ oid: s.newOid, size: 7, paths: ["hero.blend"], inTrash: true }]);
    expect(result.corrupt).toEqual([s.texOid]);
  });

  it("totals every version per file", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    const report = await usageReport(
      { repo: s.git, client: s.client, reporter: new SilentReporter(), bucket: s.bucket },
      { offline: false },
    );
    expect(report.files[0]).toMatchObject({ path: "hero.blend", versions: 2, totalBytes: 14 });
    expect(report.bucket?.orphanedBytes).toBe(6);
  });

  it("explains a path version by version", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    const result = await explain({ repo: s.git, client: s.client, reporter: new SilentReporter(), bucket: s.bucket }, "hero.blend");
    expect(result.objects.map((o) => [o.oid, o.decision.kind])).toEqual([
      [s.newOid, "keep"],
      [s.oldOid, "delete"],
    ]);
    await expect(explain({ repo: s.git, client: s.client, reporter: new SilentReporter() }, "nothing.txt")).rejects.toThrow(UsageError);
  });
});

describe("migrate", () => {
  function migrating() {
    const origin = new TempRepo();
    origin.write(".gitattributes", "*.blend filter=lfs diff=lfs merge=lfs -text\n");
    const oldOid = origin.writeLfs("hero.blend", "hero v1");
    origin.commit("v1", 100);
    origin.git("switch", "-q", "-c", "wip");
    const wipOid = origin.writeLfs("wip.blend", "work in progress");
    origin.commit("wip");
    origin.git("switch", "-q", "main");
    const newOid = origin.writeLfs("hero.blend", "hero v2");
    origin.commit("v2");
    const clone = new TempRepo(origin);
    clone.git("config", "filter.lfs.process", "git-lfs filter-process");
    cleanup.push(
      () => origin.remove(),
      () => clone.remove(),
    );

    const git = Git.open(clone.dir);
    const calls: string[] = [];
    git.lfsFetch = async (remote, refs, opts) => {
      calls.push(`fetch ${remote} ${refs.join(" ")} all=${opts?.all} url=${opts?.url} wip=${git.refTips().length}`);
      return 0;
    };
    git.lfsPushAll = async (remote) => {
      calls.push(`push ${remote}`);
      return 0;
    };
    git.lfsMigrateImport = async () => {
      calls.push("import");
      return 0;
    };
    const client = new FakeLfsClient();
    const deps = { repo: git, gitConfig: new FakeGitConfig(), gh: noGh, reporter: new SilentReporter(), connect: () => client };
    const opts = {
      server: "https://lfs.example.com",
      repo: "acme/assets",
      track: [],
      from: "https://github.com/acme/assets.git/info/lfs",
      remote: "origin",
      importPatterns: [],
      rewriteHistory: false,
      commit: true,
    };
    return { origin, clone, git, calls, client, deps, opts, oldOid, wipOid, newOid };
  }

  it("fetches every ref, copies from the old endpoint, pushes and counts what the server lacks across all history", async () => {
    const m = migrating();
    // A branch pushed after cloning must still be migrated.
    m.origin.git("switch", "-q", "-c", "late", "main");
    m.origin.commit("late branch");
    m.client.stored.set(m.newOid, "x");
    m.client.stored.set(m.wipOid, "x");

    const result = await migrate(m.deps, m.opts);
    expect(m.calls).toEqual([`fetch origin  all=true url=${m.opts.from} wip=3`, "push origin"]);
    expect(result).toMatchObject({
      url: "https://lfs.example.com/acme/assets",
      committed: true,
      rewroteHistory: false,
      missingAfterPush: 1,
    });
    expect(m.git.config("lfs.url", ".lfsconfig")).toBe("https://lfs.example.com/acme/assets");
  });

  it("refuses to start when it could not copy everything or would rewrite history unasked", async () => {
    const m = migrating();
    await expect(migrate(m.deps, { ...m.opts, importPatterns: ["*.psd"] })).rejects.toThrow(/--rewrite-history/);

    m.clone.write("dirty.txt", "uncommitted");
    await expect(migrate(m.deps, m.opts)).rejects.toThrow(/commit or stash/);
    m.clone.git("clean", "-fdq");

    m.clone.git("remote", "set-url", "origin", join(m.clone.dir, "gone"));
    await expect(migrate(m.deps, m.opts)).rejects.toThrow(/git fetch failed/);

    const shallow = new TempRepo(m.origin, "--depth", "1");
    cleanup.push(() => shallow.remove());
    await expect(migrate({ ...m.deps, repo: Git.open(shallow.dir) }, m.opts)).rejects.toThrow(/shallow/);
    expect(m.calls).toEqual([]);
  });
});

function setupFakes() {
  const runs: { args: string[]; cwd?: string }[] = [];
  const written = new Map<string, string>();
  const wrangler: Wrangler = {
    whoami: () => "me@example.com",
    run: (args, opts) => {
      runs.push({ args, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
      if (args[0] === "r2" && args[2] === "create") return { code: 1, output: "The bucket already exists" };
      return { code: 0, output: args[0] === "deploy" ? "Deployed https://r2-lfs.me.workers.dev" : "" };
    },
  };
  const files: Files = {
    sizeOf: () => undefined,
    mkdirp: () => {},
    writeText: (path, text) => written.set(path, text),
    copyFile: () => {},
    sha256: async () => "",
    writeTar: async () => {},
    tempDir: () => "/tmp/with space/r2-lfs-setup-1",
  };
  return { runs, written, deps: { wrangler, files, reporter: new SilentReporter(), workerBundle: "dist/worker.js" } };
}
describe("setup", () => {
  const base = {
    name: "r2-lfs",
    bucket: "lfs",
    owners: ["acme"],
    authMode: "github" as const,
    layout: "per-repo" as const,
    lockDays: 90,
    trashDays: 30,
    deploy: true,
  };

  it("keeps an existing bucket, adds the rules and deploys with a config path that survives a shell", async () => {
    const f = setupFakes();
    const result = await setupServer(f.deps, base);
    expect(result).toEqual({ url: "https://r2-lfs.me.workers.dev", lockPrefixes: ["acme/"] });
    expect(f.runs.map((r) => r.args.slice(0, 4).join(" "))).toEqual([
      "r2 bucket create lfs",
      "r2 bucket lifecycle add",
      "r2 bucket lock add",
      "deploy --config wrangler.json",
    ]);
    expect(f.runs.at(-1)?.cwd).toBe("/tmp/with space/r2-lfs-setup-1");
    expect(f.written.has(join("/tmp/with space/r2-lfs-setup-1", "wrangler.json"))).toBe(true);
  });

  it("skips lock rules when any owner is allowed, since they would lock the trash too", async () => {
    const f = setupFakes();
    const result = await setupServer(f.deps, { ...base, owners: ["*"], deploy: false });
    expect(result.lockPrefixes).toEqual([]);
    expect(f.runs.some((r) => r.args.includes("lock"))).toBe(false);
    expect(f.deps.reporter.warnings).toEqual([expect.stringContaining("skipping lock rules")]);
    await expect(setupServer(f.deps, { ...base, owners: ["bad owner"] })).rejects.toThrow(/not a valid/);
  });
});

describe("init and doctor", () => {
  it("writes .lfsconfig, tracks presets and probes access", async () => {
    const repo = new TempRepo();
    cleanup.push(() => repo.remove());
    repo.git("remote", "add", "origin", "git@github.com:acme/assets.git");
    repo.git("config", "filter.lfs.process", "git-lfs filter-process");
    const git = Git.open(repo.dir);
    const gitConfig = new FakeGitConfig();
    const client = new FakeLfsClient();
    const result = await initRepository(
      { repo: git, gitConfig, gh: noGh, reporter: new SilentReporter(), connect: () => client },
      { server: "https://lfs.example.com/", track: ["*.blend"] },
    );
    expect(result.location.url).toBe("https://lfs.example.com/acme/assets");
    expect(result.access).toBe("write");
    expect(git.config("lfs.url", ".lfsconfig")).toBe("https://lfs.example.com/acme/assets");
    expect(git.config("lfs.locksverify", ".lfsconfig")).toBe("false");
    expect(git.readFile(".gitattributes")).toContain("*.blend filter=lfs");
    expect(gitConfig.get("r2-lfs.server")).toBe("https://lfs.example.com");
  });

  it("stops at the first check later ones depend on and explains access problems", async () => {
    const repo = new TempRepo();
    cleanup.push(() => repo.remove());
    repo.git("config", "filter.lfs.process", "git-lfs filter-process");
    const git = Git.open(repo.dir);
    const base = { repo: git, lfsInstalled: true, gitConfig: new FakeGitConfig(), gh: noGh, r2Configured: false, ghHelper: "" };

    const noUrl = await diagnose({ ...base, connect: () => new FakeLfsClient() });
    expect(noUrl.at(-1)).toMatchObject({ name: "lfs.url", status: "fail" });

    repo.write(".lfsconfig", "[lfs]\n\turl = https://lfs.example.com/acme/assets\n\tlocksverify = false\n");
    repo.commit("config");
    const readOnly = new FakeLfsClient();
    readOnly.batch = async (operation) => {
      if (operation === "upload") throw new BatchRequestError(403, "no write");
      return [];
    };
    const checks = await diagnose({ ...base, connect: (): LfsClient => readOnly });
    expect(checks.find((c) => c.name === "access")).toMatchObject({ status: "warn" });
    expect(checks.find((c) => c.name === "R2 credentials")).toMatchObject({ status: "warn" });
  });
});
