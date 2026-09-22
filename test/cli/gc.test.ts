import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { applyGc, applyPlan, gcMode, planGc, recheckPlan } from "../../cli/app/gc.ts";
import { restoreObjects } from "../../cli/app/restore.ts";
import { UsageError } from "../../cli/domain/errors.ts";
import { BucketStorage, trashObject } from "../../cli/infra/bucket-storage.ts";
import { Git } from "../../cli/infra/git.ts";
import {
  cleanups,
  FakeLfsClient,
  MemoryBucket,
  MemoryObjectStorage,
  scenario,
  scenarioDeps,
  SilentReporter,
  storedObject,
  TempRepo,
} from "./helpers.ts";

const cleanup = cleanups();

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
    cleanup(
      () => s.repo.remove(),
      () => clone.remove(),
    );
    const deps = scenarioDeps(s, { repo: Git.open(clone.dir) });
    const opts = { fetch: true, mode: gcMode({ apply: true }), keepDays: "90" };
    const plan = await planGc(deps, opts);

    s.repo.writeLfs("hero.blend", "hero v1");
    s.repo.commit("revert");
    const outcomes = await applyPlan(deps, plan, plan.candidates, { ...opts, trash: true });
    expect(outcomes.map((o) => o.key)).toEqual([`${s.prefix}${s.orphan}`]);
    expect(s.bucket.objects.has(`${s.prefix}${s.oldOid}`)).toBe(true);
  });

  it("plans from history and moves candidates to the trash", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    const deps = scenarioDeps(s);

    // By default only objects no commit uses are collected, so every commit stays checkoutable.
    const byDefault = await planGc(deps, { fetch: false, mode: "dry-run" });
    expect(Object.fromEntries(byDefault.planned.map((p) => [p.oid, p.decision]))).toEqual({
      [s.oldOid]: { kind: "keep", reason: "hero.blend: used by a commit" },
      [s.newOid]: { kind: "keep", reason: "in a branch or tag tip" },
      [s.texOid]: { kind: "keep", reason: "in a branch or tag tip" },
      [s.orphan]: { kind: "delete" },
      [s.youngOrphan]: { kind: "young" },
    });

    const plan = await planGc(deps, { fetch: false, mode: "dry-run", keepDays: "90" });
    const decisions = Object.fromEntries(plan.planned.map((p) => [p.oid, p.decision.kind]));
    expect(decisions).toEqual({
      [s.oldOid]: "delete",
      [s.newOid]: "keep",
      [s.texOid]: "keep",
      [s.orphan]: "delete",
      [s.youngOrphan]: "young",
    });

    const outcomes = await applyGc(deps, plan.candidates, { trash: true });
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(s.bucket.objects.has(`_trash/${s.prefix}${s.oldOid}`)).toBe(true);
    expect(s.bucket.objects.has(`${s.prefix}${s.oldOid}`)).toBe(false);
  });

  it("applies each candidate's decision through the storage port and answers in plan order", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    s.repo.write(".r2-lfs.toml", 'keep_days = 90\n[[rule]]\npath = "*.blend"\nold_versions = "infrequent-access"\n');
    s.repo.commit("policy");
    const storage = new MemoryObjectStorage();
    for (const object of await s.bucket.list("")) storage.objects.set(object.key, object);
    const deps = scenarioDeps(s, { storage });

    const plan = await planGc(deps, { fetch: false, mode: "dry-run" });
    expect(await applyGc(deps, plan.candidates, { trash: true })).toEqual([
      { key: `${s.prefix}${s.oldOid}`, action: "tiered", ok: true },
      { key: `${s.prefix}${s.orphan}`, action: "trashed", ok: true },
    ]);
    expect(storage.objects.get(`${s.prefix}${s.oldOid}`)?.storageClass).toBe("STANDARD_IA");
    expect(storage.objects.has(`_trash/${s.prefix}${s.orphan}`)).toBe(true);
  });

  it("reports objects a bucket lock still protects as locked, dropping the trash copy", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    s.bucket.locked.push(s.prefix);
    const deps = scenarioDeps(s);
    const plan = await planGc(deps, { fetch: false, mode: "dry-run", keepDays: "90" });
    const outcomes = await applyGc(deps, plan.candidates, { trash: true });
    expect(outcomes).toEqual(plan.candidates.map((p) => ({ key: p.object.key, action: "locked", ok: true })));
    expect(s.bucket.objects.has(`${s.prefix}${s.oldOid}`)).toBe(true);
    expect([...s.bucket.objects.keys()].some((k) => k.startsWith("_trash/"))).toBe(false);
  });

  it("deletes without the trash, tiers, and reports what a lock refuses", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    s.repo.write(".r2-lfs.toml", 'keep_days = 90\n[[rule]]\npath = "*.blend"\nold_versions = "infrequent-access"\n');
    s.repo.commit("policy");
    const deps = scenarioDeps(s);
    const plan = await planGc(deps, { fetch: false, mode: "dry-run" });
    expect(plan.candidates.map((p) => [p.oid, p.decision.kind])).toEqual([
      [s.oldOid, "tier"],
      [s.orphan, "delete"],
    ]);

    s.bucket.forbidden.push(`${s.prefix}${s.orphan}`);
    const outcomes = await applyGc(deps, plan.candidates, { trash: false });
    expect(outcomes).toEqual([
      { key: `${s.prefix}${s.oldOid}`, action: "tiered", ok: true },
      { key: `${s.prefix}${s.orphan}`, action: "delete", ok: false, message: "403 AccessDenied" },
    ]);
    s.bucket.forbidden.length = 0;
    s.bucket.locked.push(s.prefix);
    expect(await applyGc(deps, plan.candidates, { trash: false })).toEqual([
      { key: `${s.prefix}${s.oldOid}`, action: "locked", ok: true },
      { key: `${s.prefix}${s.orphan}`, action: "locked", ok: true },
    ]);
    expect(s.bucket.objects.get(`${s.prefix}${s.oldOid}`)?.storageClass).toBe("STANDARD_IA");

    s.bucket.locked.length = 0;
    const deleted = await applyGc(deps, plan.candidates.slice(1), { trash: false });
    expect(deleted).toEqual([{ key: `${s.prefix}${s.orphan}`, action: "deleted", ok: true }]);
    expect([...s.bucket.objects.keys()].some((k) => k.startsWith("_trash/"))).toBe(false);
  });

  it("never loses the only copy when copying or deleting goes wrong", async () => {
    const bucket = new MemoryBucket();

    expect(await trashObject(bucket, storedObject("acme/assets/missing"))).toMatchObject({
      ok: false,
      message: "copy failed: 404 NoSuchKey",
    });

    bucket.seed("acme/assets/timeout");
    bucket.deletesThatTimeOut.add("acme/assets/timeout");
    expect(await trashObject(bucket, storedObject("acme/assets/timeout"))).toMatchObject({ ok: true, action: "trashed" });
    expect(bucket.objects.has("_trash/acme/assets/timeout")).toBe(true);

    bucket.seed("acme/assets/unknown");
    bucket.forbidden.push("acme/assets/unknown");
    bucket.exists = async () => {
      throw new Error("network down");
    };
    expect(await trashObject(bucket, storedObject("acme/assets/unknown"))).toMatchObject({
      ok: false,
      message: expect.stringContaining("kept the trash copy"),
    });
    expect(bucket.objects.has("acme/assets/unknown")).toBe(true);
    expect(bucket.objects.has("_trash/acme/assets/unknown")).toBe(true);
  });

  it("drops candidates that commits pushed after planning need", async () => {
    const s = scenario();
    const clone = new TempRepo(s.repo);
    cleanup(
      () => s.repo.remove(),
      () => clone.remove(),
    );
    const deps = scenarioDeps(s, { repo: Git.open(clone.dir) });
    const opts = { fetch: true, mode: "apply" as const, keepDays: "90" };
    const plan = await planGc(deps, opts);
    expect(plan.candidates.map((p) => p.oid)).toEqual([s.oldOid, s.orphan]);
    expect(await recheckPlan(deps, plan, plan.candidates, opts)).toEqual(plan.candidates);

    // Someone reverts to the old version; git-lfs does not upload it again, so its upload date stays old.
    s.repo.writeLfs("hero.blend", "hero v1");
    s.repo.commit("revert");
    const rechecked = await recheckPlan(deps, plan, plan.candidates, opts);
    expect(rechecked.map((p) => p.oid)).toEqual([s.orphan]);
    expect(deps.reporter.warnings).toEqual([expect.stringContaining("1 object(s) are needed by commits pushed")]);

    // With --no-fetch there is nothing to compare against; when fetching fails, nothing is applied.
    expect(await recheckPlan(deps, plan, plan.candidates, { ...opts, fetch: false })).toEqual(plan.candidates);
    clone.git("remote", "set-url", "origin", join(clone.dir, "gone"));
    await expect(recheckPlan(deps, plan, plan.candidates, opts)).rejects.toThrow(/nothing was changed/);
  });

  it("keeps objects of older commits inside the keep_days window of the rule for their path", async () => {
    const repo = new TempRepo();
    cleanup(() => repo.remove());
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
      {
        repo: Git.open(repo.dir),
        otherRepos: [],
        client: new FakeLfsClient(),
        storage: new BucketStorage(bucket),
        reporter: new SilentReporter(),
      },
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
    cleanup(() => s.repo.remove());
    s.repo.write(".r2-lfs.toml", 'keep_days = 90\n[[rule]]\npath = "*.blend"\nkeep_versions = 2\n');
    s.repo.commit("policy");
    const deps = scenarioDeps(s);
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

    s.repo.write(".r2-lfs.toml", "keep_versions = 2\n");
    await expect(planGc(deps, { fetch: false, mode: "dry-run" })).rejects.toThrow(/only applies together with keep_days/);
    const withFlag = await planGc(deps, { fetch: false, mode: "dry-run", keepDays: "90" });
    expect(withFlag.planned.find((p) => p.oid === s.oldOid)?.decision).toEqual({
      kind: "keep",
      reason: "hero.blend: one of the newest 2 versions",
    });
  });

  it("refuses to change an encrypting server's bucket without the key", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    s.client.serverInfo = { ...s.client.serverInfo, encrypted: true };
    const deps = scenarioDeps(s);
    expect((await planGc(deps, { fetch: false, mode: "dry-run" })).candidates.length).toBeGreaterThan(0);
    await expect(planGc(deps, { fetch: false, mode: "apply" })).rejects.toThrow(/R2_LFS_ENCRYPTION_KEY/);
    await expect(restoreObjects(deps, [])).rejects.toThrow(/R2_LFS_ENCRYPTION_KEY/);
    s.bucket.encrypted = true;
    expect((await planGc(deps, { fetch: false, mode: "apply" })).candidates.length).toBeGreaterThan(0);
  });

  it("refuses clones with incomplete history, and stops on a failed fetch unless it only reports", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    const reporter = new SilentReporter();
    const shallow = new TempRepo(s.repo, "--depth", "1");
    cleanup(() => shallow.remove());
    const deps = (repo: Git) => scenarioDeps(s, { repo, reporter });
    await expect(planGc(deps(Git.open(shallow.dir)), { fetch: false, mode: "dry-run" })).rejects.toThrow(/full history/);

    s.repo.git("remote", "add", "origin", join(s.repo.dir, "does-not-exist"));
    await expect(planGc(deps(s.git), { fetch: true, mode: "apply" })).rejects.toThrow(/git fetch failed/);
    await expect(planGc(deps(s.git), { fetch: true, mode: "interactive" })).rejects.toThrow(/git fetch failed/);
    await planGc(deps(s.git), { fetch: true, mode: "dry-run" });
    expect(reporter.warnings).toEqual([expect.stringContaining("git fetch failed")]);
  });

  it("flags the shared layout without other repositories and refuses to apply without picking", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    s.client.serverInfo.storageLayout = "shared";
    const deps = scenarioDeps(s);
    const plan = await planGc(deps, { fetch: false, mode: "dry-run" });
    expect(plan.sharedWithoutRepos).toBe(true);
    expect(plan.prefix).toBe("_shared/");
    await expect(planGc(deps, { fetch: false, mode: "apply" })).rejects.toThrow(/without --repos/);
    expect((await planGc(deps, { fetch: false, mode: "interactive" })).sharedWithoutRepos).toBe(true);
  });

  it("judges each repository in the shared layout by its own policy", async () => {
    const s = scenario();
    const other = new TempRepo();
    cleanup(
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
    const deps = scenarioDeps(s, { otherRepos: [Git.open(other.dir)], storage: new BucketStorage(bucket) });
    s.repo.write(".r2-lfs.toml", "keep_days = 90\n");

    const plan = await planGc(deps, { fetch: false, mode: "apply" });
    expect(Object.fromEntries(plan.planned.map((p) => [p.oid, p.decision.kind]))).toEqual({
      [s.oldOid]: "delete",
      [s.newOid]: "keep",
      [finalOld]: "keep",
      [finalNew]: "keep",
      [s.orphan]: "delete",
    });

    const shallow = new TempRepo(other, "--depth", "1");
    cleanup(() => shallow.remove());
    await expect(planGc({ ...deps, otherRepos: [Git.open(shallow.dir)] }, { fetch: false, mode: "dry-run" })).rejects.toThrow(
      /full history of .*r2-lfs-test-/,
    );

    const perRepo = { ...deps, client: new FakeLfsClient() };
    await expect(planGc(perRepo, { fetch: false, mode: "dry-run" })).rejects.toThrow(/only applies to the shared layout/);
  });
});
