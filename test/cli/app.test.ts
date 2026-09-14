import { rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { archiveTag } from "../../cli/app/archive.ts";
import { parseCredentialRequest, passwordFor } from "../../cli/app/credential.ts";
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
  type MultipartUploads,
  type SavedUpload,
  TransferError,
  type UploadedPart,
  type Wrangler,
} from "../../cli/app/ports.ts";
import { listTrash, restoreObjects, selectTrash } from "../../cli/app/restore.ts";
import { setupServer } from "../../cli/app/setup.ts";
import { createToken, listTokens, revoke } from "../../cli/app/token.ts";
import { runTransferAgent } from "../../cli/app/transfer-agent.ts";
import { usageReport } from "../../cli/app/usage.ts";
import { verifyObjects } from "../../cli/app/verify.ts";
import { explain } from "../../cli/app/why.ts";
import { UsageError } from "../../cli/domain/errors.ts";
import { Git } from "../../cli/infra/git.ts";
import { LocalFiles } from "../../cli/infra/local-files.ts";
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
  useCredentialHelper() {}
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

const pointer = (oid: string) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 5\n`;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
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
    const plan = await planGc(
      { repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter },
      { fetch: false, mode: "dry-run" },
    );

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
    const plan = await planGc(
      { repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter },
      { fetch: false, mode: "dry-run" },
    );
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
    const plan = await planGc(
      { repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter },
      { fetch: false, mode: "dry-run" },
    );
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

    // With --no-fetch there is nothing to compare against; when fetching fails, nothing is applied.
    expect(await recheckPlan(deps, plan, plan.candidates, { ...opts, fetch: false })).toEqual(plan.candidates);
    clone.git("remote", "set-url", "origin", join(clone.dir, "gone"));
    await expect(recheckPlan(deps, plan, plan.candidates, opts)).rejects.toThrow(/nothing was changed/);
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
      { fetch: false, mode: "dry-run" },
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
    const byPolicy = await planGc(deps, { fetch: false, mode: "dry-run" });
    expect(byPolicy.planned.find((p) => p.oid === s.oldOid)?.decision.kind).toBe("keep");

    const overridden = await planGc(deps, { fetch: false, minAgeDays: "0", mode: "dry-run" });
    expect(overridden.planned.find((p) => p.oid === s.youngOrphan)?.decision.kind).toBe("delete");
    await expect(planGc(deps, { fetch: false, keepDays: "-1", mode: "dry-run" })).rejects.toThrow(UsageError);
    for (const blank of ["", " ", "1.5", "7 days"]) {
      await expect(planGc(deps, { fetch: false, minAgeDays: blank, mode: "dry-run" })).rejects.toThrow(
        /--min-age-days must be a non-negative integer/,
      );
    }
  });

  it("refuses to change an encrypting server's bucket without the key", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    s.client.serverInfo = { ...s.client.serverInfo, encrypted: true };
    const deps = { repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter: new SilentReporter() };
    expect((await planGc(deps, { fetch: false, mode: "dry-run" })).candidates.length).toBeGreaterThan(0);
    await expect(planGc(deps, { fetch: false, mode: "apply" })).rejects.toThrow(/R2_LFS_ENCRYPTION_KEY/);
    await expect(restoreObjects({ bucket: s.bucket, reporter: new SilentReporter(), client: s.client }, [])).rejects.toThrow(
      /R2_LFS_ENCRYPTION_KEY/,
    );
    s.bucket.encrypted = true;
    expect((await planGc(deps, { fetch: false, mode: "apply" })).candidates.length).toBeGreaterThan(0);
  });

  it("refuses clones with incomplete history, and stops on a failed fetch unless it only reports", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    const reporter = new SilentReporter();
    const shallow = new TempRepo(s.repo, "--depth", "1");
    cleanup.push(() => shallow.remove());
    const deps = (repo: Git) => ({ repo, otherRepos: [], client: s.client, bucket: s.bucket, reporter });
    await expect(planGc(deps(Git.open(shallow.dir)), { fetch: false, mode: "dry-run" })).rejects.toThrow(/full history/);

    s.repo.git("remote", "add", "origin", join(s.repo.dir, "does-not-exist"));
    await expect(planGc(deps(s.git), { fetch: true, mode: "apply" })).rejects.toThrow(/git fetch failed/);
    await expect(planGc(deps(s.git), { fetch: true, mode: "interactive" })).rejects.toThrow(/git fetch failed/);
    await planGc(deps(s.git), { fetch: true, mode: "dry-run" });
    expect(reporter.warnings).toEqual([expect.stringContaining("git fetch failed")]);
  });

  it("flags the shared layout without other repositories and refuses to apply without picking", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    s.client.serverInfo.storageLayout = "shared";
    const deps = { repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter: new SilentReporter() };
    const plan = await planGc(deps, { fetch: false, mode: "dry-run" });
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

    const shallow = new TempRepo(other, "--depth", "1");
    cleanup.push(() => shallow.remove());
    await expect(planGc({ ...deps, otherRepos: [Git.open(shallow.dir)] }, { fetch: false, mode: "dry-run" })).rejects.toThrow(
      /full history of .*r2-lfs-test-/,
    );

    const perRepo = { ...deps, client: new FakeLfsClient() };
    await expect(planGc(perRepo, { fetch: false, mode: "dry-run" })).rejects.toThrow(/only applies to the shared layout/);
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

  it("selects by date and rejects ambiguous prefixes, and says when a restore is incomplete", async () => {
    const bucket = new MemoryBucket();
    const reporter = new SilentReporter();
    const trashed = (oid: string, daysAgo: number) => ({
      object: { ...object(`_trash/acme/assets/${oid}`), lastModified: at(daysAgo) },
      oid,
      paths: [],
    });
    const trash = [trashed(`ab${"1".repeat(62)}`, 10), trashed(`ab${"2".repeat(62)}`, 1)];
    expect(selectTrash(trash, { kind: "since", date: at(5) }).map((t) => t.oid)).toEqual([trash[1]!.oid]);
    expect(() => selectTrash(trash, { kind: "oids", prefixes: ["ab"] })).toThrow(/ambiguous/);

    const [missing, locked] = trash;
    bucket.seed(locked!.object.key);
    bucket.locked.push("_trash/");
    expect(await restoreObjects({ bucket, reporter }, [missing!, locked!])).toEqual([
      { oid: missing!.oid, ok: false, message: "copy failed: 404 NoSuchKey" },
      { oid: locked!.oid, ok: true, message: expect.stringContaining("trash copy could not be removed") },
    ]);
    expect(bucket.objects.has(`acme/assets/${locked!.oid}`)).toBe(true);
  });
});

describe("tokens", () => {
  it("creates, lists and revokes without storing the token", async () => {
    const bucket = new MemoryBucket();
    const { token, entry } = await createToken(bucket, { label: "laptop", scope: "acme/*", permission: "write" });
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
    await createToken(bucket, { label: "laptop", scope: "acme/*", permission: "write" });
    const read = bucket.get.bind(bucket);
    const racing = async (key: string) => {
      const current = await read(key);
      await bucket.put(key, JSON.stringify({ version: 1, tokens: [] }));
      bucket.get = read;
      return current;
    };

    bucket.get = racing;
    await expect(createToken(bucket, { label: "ci", scope: "acme/*", permission: "read" })).rejects.toBeInstanceOf(ConflictError);
    await createToken(bucket, { label: "desk", scope: "acme/*", permission: "read" });
    bucket.get = racing;
    await expect(revoke(bucket, "desk")).rejects.toBeInstanceOf(ConflictError);

    const empty = new MemoryBucket();
    empty.get = async (key) => {
      await empty.put(key, JSON.stringify({ version: 1, tokens: [] }));
      return undefined;
    };
    await expect(createToken(empty, { label: "first", scope: "*", permission: "read" })).rejects.toBeInstanceOf(ConflictError);
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

  it("explains an object by oid prefix, and without bucket access judges it as if uploaded long ago", async () => {
    const repo = new TempRepo();
    cleanup.push(() => repo.remove());
    const first = `abcdef${"1".repeat(58)}`;
    const second = `abcdef${"2".repeat(58)}`;
    repo.write("one.bin", pointer(first));
    repo.write("two.bin", pointer(second));
    repo.commit("objects", 200);
    repo.write("one.bin", pointer("c".repeat(64)));
    repo.write("two.bin", pointer("d".repeat(64)));
    repo.commit("replaced");

    const client = new FakeLfsClient();
    client.stored.set(first, "x");
    const bucket = new MemoryBucket();
    bucket.seed(`acme/assets/${first}`, { ageDays: 2 });
    bucket.seed(`_trash/acme/assets/${second}`);
    const deps = { repo: Git.open(repo.dir), client, reporter: new SilentReporter() };

    await expect(explain(deps, "abcdef")).rejects.toThrow(/abcdef is ambiguous/);
    await expect(explain(deps, "abcdef9")).rejects.toThrow(/no LFS object in history starts with abcdef9/);

    const withBucket = await explain({ ...deps, bucket }, "abcdef1");
    expect(withBucket.path).toBeUndefined();
    expect(withBucket.objects).toEqual([
      expect.objectContaining({
        oid: first,
        paths: ["one.bin"],
        onServer: true,
        inTrash: false,
        uploaded: expect.any(Date),
        decision: { kind: "young" },
      }),
    ]);
    const withoutBucket = await explain(deps, "abcdef1");
    expect(withoutBucket.objects[0]).toMatchObject({ onServer: true, decision: { kind: "delete" } });
    expect(withoutBucket.objects[0]?.uploaded).toBeUndefined();
    expect((await explain({ ...deps, bucket }, "abcdef2")).objects[0]).toMatchObject({ onServer: false, inTrash: true });
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
  const copied: string[] = [];
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
    copyDir: (from, to) => copied.push(`${from} -> ${to}`),
    sha256: async () => "",
    writeTar: async () => {},
    tempDir: () => "/tmp/with space/r2-lfs-setup-1",
  };
  return {
    runs,
    written,
    copied,
    deps: { wrangler, files, reporter: new SilentReporter(), workerFiles: { worker: "dist/worker", assets: "dist/public" } },
  };
}
describe("archive", () => {
  function archiving() {
    const repo = new TempRepo();
    cleanup.push(() => repo.remove());
    repo.git("remote", "add", "origin", "https://github.com/acme/assets.git");
    repo.write("README.md", "hello");
    const oid = repo.writeLfs("hero.blend", "hero content");
    repo.commit("release");
    repo.git("tag", "v1");

    const git = Git.open(repo.dir);
    const media = join(repo.dir, ".git", "test-lfs");
    git.lfsObjectPath = (id) => join(media, id);
    git.lfsFetch = async () => 0;
    const files = new LocalFiles();
    files.mkdirp(media);
    const events: string[] = [];
    let state: "draft" | "published" | undefined;
    const gh: GitHubCli = {
      available: () => true,
      loggedIn: () => true,
      releaseState: () => state,
      createDraftRelease: (target, tag) => {
        events.push(`draft ${target} ${tag}`);
        state = "draft";
      },
      uploadAssets: async (_target, _tag, assets) => {
        events.push(`upload ${assets.length}`);
        return 0;
      },
      publishRelease: () => {
        events.push("publish");
        state = "published";
      },
    };
    const deps = { repo: git, gh, files, reporter: new SilentReporter() };
    const opts = { tag: "v1", partBytes: 1024 ** 2, upload: true, remote: "origin" };
    return { repo, files, media, oid, events, deps, opts, setState: (s: typeof state) => (state = s) };
  }

  it("needs every LFS object locally, then uploads to a draft before publishing", async () => {
    const a = archiving();
    await expect(archiveTag(a.deps, a.opts)).rejects.toThrow(/hero.blend is not available locally/);
    expect(a.events).toEqual([]);

    a.files.writeText(join(a.media, a.oid), "hero content");
    const result = await archiveTag(a.deps, a.opts);
    cleanup.push(() => rmSync(result.outputDir, { recursive: true, force: true }));
    expect(result).toMatchObject({ published: true, totalBytes: "hello".length + "hero content".length });
    expect(result.files.map((f) => f.slice(result.outputDir.length + 1))).toEqual(["assets-v1.tar", "SHA256SUMS"]);
    expect(a.events).toEqual(["draft acme/assets v1", "upload 2", "publish"]);
  });

  it("refuses a release that is already published or a revision that is not a tag", async () => {
    const a = archiving();
    a.setState("published");
    await expect(archiveTag(a.deps, a.opts)).rejects.toThrow(/already published/);
    await expect(archiveTag(a.deps, { ...a.opts, tag: "HEAD" })).rejects.toThrow(/is not a tag/);
    a.files.writeText(join(a.media, a.oid), "hero content");
    const local = await archiveTag(a.deps, { ...a.opts, tag: "HEAD", upload: false });
    cleanup.push(() => rmSync(local.outputDir, { recursive: true, force: true }));
    expect(local.published).toBe(false);
  });
});

describe("setup", () => {
  const base = {
    name: "r2-lfs",
    bucket: "lfs",
    repos: ["acme/*"],
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
      "r2 bucket lifecycle add",
      "r2 bucket lock add",
      "deploy --config wrangler.json",
    ]);
    expect(f.runs.at(-1)?.cwd).toBe("/tmp/with space/r2-lfs-setup-1");
    expect(f.written.has(join("/tmp/with space/r2-lfs-setup-1", "wrangler.json"))).toBe(true);
    expect(f.copied).toEqual([
      `dist/worker -> ${join("/tmp/with space/r2-lfs-setup-1", "worker")}`,
      `dist/public -> ${join("/tmp/with space/r2-lfs-setup-1", "public")}`,
    ]);
  });

  it("locks each repository pattern up to its first *, and skips patterns that would lock the trash too", async () => {
    const f = setupFakes();
    const result = await setupServer(f.deps, { ...base, repos: ["*/assets", "me/blender-*"], deploy: false });
    expect(result.lockPrefixes).toEqual(["me/blender-"]);
    expect(f.runs.filter((r) => r.args.includes("lock")).map((r) => r.args[6])).toEqual(["me/blender-"]);
    expect(f.deps.reporter.warnings).toEqual([expect.stringContaining("*/assets cannot be locked")]);

    const everyone = setupFakes();
    expect((await setupServer(everyone.deps, { ...base, repos: ["*"], deploy: false })).lockPrefixes).toEqual([]);
    expect(everyone.runs.some((r) => r.args.includes("lock"))).toBe(false);
    await expect(setupServer(f.deps, { ...base, repos: ["acme"] })).rejects.toThrow(/is not owner\/repo/);
    await expect(setupServer(f.deps, { ...base, repos: [] })).rejects.toThrow(/--repos is required/);
  });
});

describe("credential helper", () => {
  it("answers with R2_LFS_TOKEN first, then an Actions OIDC token for the audience the server announces", async () => {
    const requested: string[] = [];
    const actions = { available: () => true, request: async (audience: string) => (requested.push(audience), `oidc-for-${audience}`) };
    const client = new FakeLfsClient();
    const origins: string[] = [];
    const connect = (location: { origin: string }) => (origins.push(location.origin), client);

    expect(await passwordFor({ token: "from-env", actions, connect }, "https://lfs.example.com")).toBe("from-env");
    expect(requested).toEqual([]);

    expect(await passwordFor({ token: undefined, actions, connect }, "https://lfs.example.com")).toBeUndefined();
    client.serverInfo = { ...client.serverInfo, actionsOidcAudience: "r2-lfs" };
    expect(await passwordFor({ token: undefined, actions, connect }, "https://lfs.example.com")).toBe("oidc-for-r2-lfs");
    expect(origins).toEqual(["https://lfs.example.com", "https://lfs.example.com"]);

    const outside = { available: () => false, request: async () => "never" };
    expect(await passwordFor({ token: undefined, actions: outside, connect }, "https://lfs.example.com")).toBeUndefined();
    client.info = async () => {
      throw new Error("offline");
    };
    expect(await passwordFor({ token: undefined, actions, connect }, "https://lfs.example.com")).toBeUndefined();
  });

  it("reads git's credential request", () => {
    expect(Object.fromEntries(parseCredentialRequest("protocol=https\r\nhost=lfs.example.com:8443\npath=a=b\n\n"))).toEqual({
      protocol: "https",
      host: "lfs.example.com:8443",
      path: "a=b",
    });
  });
});

describe("transfer agent", () => {
  const OID = "d".repeat(64);
  const action = { href: "https://lfs.example.com/acme/assets/objects/dd/multipart", header: { Authorization: "Basic x" } };
  const CONTENT = new TextEncoder().encode("abcdefghijkl");

  class FakeUploads implements MultipartUploads {
    started = 0;
    sent: number[] = [];
    completed: { uploadId: string; size: number; parts: UploadedPart[] }[] = [];
    /** Errors to throw, in order, before calls succeed. */
    failures: { on: "part" | "complete"; error: Error }[] = [];
    forget = false;

    private fail(on: "part" | "complete") {
      const index = this.failures.findIndex((f) => f.on === on);
      if (index >= 0) throw this.failures.splice(index, 1)[0]!.error;
    }
    async start() {
      this.started++;
      return { uploadId: `upload-${this.started}`, partSize: 5 };
    }
    async uploadPart(_action: unknown, uploadId: string, partNumber: number, data: Uint8Array) {
      this.fail("part");
      if (this.forget && uploadId === "saved") return undefined;
      this.sent.push(partNumber);
      return { partNumber, etag: `${uploadId}-${partNumber}-${data.byteLength}` };
    }
    async complete(_action: unknown, uploadId: string, size: number, parts: UploadedPart[]) {
      this.fail("complete");
      this.completed.push({ uploadId, size, parts });
    }
  }

  class MemoryStates {
    readonly map = new Map<string, SavedUpload>();
    load(oid: string) {
      const state = this.map.get(oid);
      return state && structuredClone(state);
    }
    save(oid: string, state: SavedUpload) {
      this.map.set(oid, structuredClone(state));
    }
    remove(oid: string) {
      this.map.delete(oid);
    }
  }

  async function run(uploads: FakeUploads, states: MemoryStates, messages: object[]) {
    const out: Record<string, unknown>[] = [];
    const sleeps: number[] = [];
    const deps = {
      uploads,
      states,
      readPart: async (_path: string, offset: number, length: number) => CONTENT.slice(offset, offset + length),
      sleep: async (ms: number) => void sleeps.push(ms),
    };
    async function* lines() {
      for (const m of messages) yield JSON.stringify(m);
    }
    await runTransferAgent(deps, lines(), (m) => out.push(m));
    return { out, sleeps };
  }

  const uploadMessage = { event: "upload", oid: OID, size: CONTENT.byteLength, path: "/tmp/x", action };

  it("uploads in parts, reports progress and completes, then forgets the upload", async () => {
    const uploads = new FakeUploads();
    const states = new MemoryStates();
    const { out } = await run(uploads, states, [
      { event: "init", operation: "upload" },
      uploadMessage,
      { event: "terminate" },
      uploadMessage,
    ]);
    expect(out[0]).toEqual({});
    expect(out.filter((m) => m.event === "progress").map((m) => m.bytesSoFar)).toEqual([5, 10, 12]);
    expect(out.at(-1)).toEqual({ event: "complete", oid: OID });
    expect(uploads.completed).toEqual([
      { uploadId: "upload-1", size: 12, parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: `upload-1-${n}-${n === 3 ? 2 : 5}` })) },
    ]);
    expect(states.map.size).toBe(0);
    // Nothing is read after terminate.
    expect(uploads.started).toBe(1);
  });

  it("continues an interrupted upload from the parts the server already has", async () => {
    const uploads = new FakeUploads();
    const states = new MemoryStates();
    states.save(OID, { href: action.href, size: 12, uploadId: "saved", partSize: 5, parts: [{ partNumber: 1, etag: "kept" }] });
    const { out } = await run(uploads, states, [uploadMessage]);
    expect(uploads.started).toBe(0);
    expect(uploads.sent).toEqual([2, 3]);
    expect(uploads.completed[0]?.parts[0]).toEqual({ partNumber: 1, etag: "kept" });
    expect(out.at(-1)).toEqual({ event: "complete", oid: OID });
  });

  it("starts over when the server no longer has the saved upload", async () => {
    const uploads = new FakeUploads();
    uploads.forget = true;
    const states = new MemoryStates();
    states.save(OID, { href: action.href, size: 12, uploadId: "saved", partSize: 5, parts: [{ partNumber: 1, etag: "kept" }] });
    const { out } = await run(uploads, states, [uploadMessage]);
    expect(uploads.started).toBe(1);
    expect(uploads.completed[0]?.uploadId).toBe("upload-1");
    expect(out.at(-1)).toEqual({ event: "complete", oid: OID });
  });

  it("retries dropped connections and server errors, but not refusals", async () => {
    const uploads = new FakeUploads();
    uploads.failures = [
      { on: "part", error: new TransferError(undefined, "socket hang up") },
      { on: "part", error: new TransferError(503, "busy") },
    ];
    const states = new MemoryStates();
    const { out, sleeps } = await run(uploads, states, [uploadMessage]);
    expect(sleeps).toEqual([500, 1000]);
    expect(out.at(-1)).toEqual({ event: "complete", oid: OID });

    const refused = new FakeUploads();
    refused.failures = [{ on: "complete", error: new TransferError(422, "Uploaded content does not match the oid and size") }];
    const result = await run(refused, states, [uploadMessage]);
    expect(result.sleeps).toEqual([]);
    expect(result.out.at(-1)).toEqual({
      event: "complete",
      oid: OID,
      error: { code: 422, message: expect.stringContaining("does not match") },
    });
    expect(states.map.size).toBe(0);
  });

  it("keeps the upload for the next push when the server stays unreachable", async () => {
    const uploads = new FakeUploads();
    uploads.failures = Array.from({ length: 4 }, () => ({ on: "complete" as const, error: new TransferError(undefined, "offline") }));
    const states = new MemoryStates();
    const { out } = await run(uploads, states, [uploadMessage]);
    expect(out.at(-1)).toMatchObject({ event: "complete", error: { message: "offline" } });
    expect(states.load(OID)?.parts).toHaveLength(3);
  });

  it("declines downloads, which stay with git-lfs's own resumable transfer", async () => {
    const { out } = await run(new FakeUploads(), new MemoryStates(), [
      { event: "init", operation: "download" },
      { event: "download", oid: OID },
    ]);
    expect(out[0]).toMatchObject({ error: { message: expect.stringContaining("only uploads") } });
    expect(out[1]).toMatchObject({ event: "complete", oid: OID, error: { code: 1 } });
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
      { server: "https://lfs.example.com/", track: ["*.blend"], lockable: true },
    );
    expect(result.location.url).toBe("https://lfs.example.com/acme/assets");
    expect(result.access).toBe("write");
    expect(git.config("lfs.url", ".lfsconfig")).toBe("https://lfs.example.com/acme/assets");
    expect(git.config("lfs.locksverify", ".lfsconfig")).toBe("true");
    expect(git.readFile(".gitattributes")).toContain("*.blend filter=lfs diff=lfs merge=lfs -text lockable");
    expect(gitConfig.get("r2-lfs.server")).toBe("https://lfs.example.com");
    expect(gitConfig.get("lfs.customtransfer.r2-lfs-multipart.path")).toBeUndefined();

    await initRepository(
      { repo: git, gitConfig, gh: noGh, reporter: new SilentReporter(), connect: () => client },
      {
        server: "https://lfs.example.com",
        track: [],
        transferAgent: { path: "/usr/bin/node", args: '"/opt/r2-lfs/cli.js" transfer-agent' },
      },
    );
    expect(gitConfig.get("lfs.customtransfer.r2-lfs-multipart.path")).toBe("/usr/bin/node");
    expect(gitConfig.get("lfs.customtransfer.r2-lfs-multipart.args")).toBe('"/opt/r2-lfs/cli.js" transfer-agent');
    expect(gitConfig.get("lfs.customtransfer.r2-lfs-multipart.direction")).toBe("upload");
  });

  it("validates its inputs, keeps a remembered server and reports when access cannot be checked", async () => {
    const repo = new TempRepo();
    cleanup.push(() => repo.remove());
    repo.git("config", "filter.lfs.process", "git-lfs filter-process");
    const git = Git.open(repo.dir);
    const gitConfig = new FakeGitConfig();
    gitConfig.values.set("r2-lfs.server", "https://first.example.com");
    gitConfig.token = undefined;
    const client = new FakeLfsClient();
    client.hasCredentials = false;
    client.serverInfo.authMode = "token";
    const reporter = new SilentReporter();
    const deps = { repo: git, gitConfig, gh: noGh, reporter, connect: () => client };
    const base = { server: "https://lfs.example.com", track: [] };

    await expect(initRepository(deps, base)).rejects.toThrow(/--repo owner\/name/);
    await expect(initRepository(deps, { ...base, repo: "acme" })).rejects.toThrow(/owner\/name/);
    await expect(initRepository(deps, { ...base, repo: "acme/assets/extra" })).rejects.toThrow(/owner\/name/);
    await expect(initRepository(deps, { ...base, server: "https://lfs.example.com/acme/assets", repo: "acme/assets" })).rejects.toThrow(
      /just an origin/,
    );
    await expect(initRepository(deps, { ...base, repo: "acme/assets", credential: "gh" })).rejects.toThrow(/gh auth login/);
    expect(reporter.warnings).toEqual([expect.stringContaining("its own tokens")]);

    const result = await initRepository(deps, { ...base, repo: "acme/assets" });
    expect(result).toMatchObject({ credential: "none", access: "unknown" });

    // gh logs in to github.com, so a GitHub Enterprise Server does not get its token by default.
    client.serverInfo = { ...client.serverInfo, authMode: "github", authHost: "https://ghe.example.com" };
    const loggedIn = { ...noGh, loggedIn: () => true };
    expect((await initRepository({ ...deps, gh: loggedIn }, { ...base, repo: "acme/assets" })).credential).toBe("none");
    client.serverInfo = { ...client.serverInfo, authHost: "https://github.com" };
    expect((await initRepository({ ...deps, gh: loggedIn }, { ...base, repo: "acme/assets" })).credential).toBe("gh");
    expect(gitConfig.get("r2-lfs.server")).toBe("https://first.example.com");
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

    readOnly.serverInfo = { ...readOnly.serverInfo, warnings: ["ALLOWED_OWNERS is deprecated"] };
    const warned = await diagnose({ ...base, connect: (): LfsClient => readOnly });
    expect(warned.find((c) => c.name === "server settings")).toMatchObject({ status: "warn", detail: "ALLOWED_OWNERS is deprecated" });
  });
});
