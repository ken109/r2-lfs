import { afterEach, describe, expect, it } from "vitest";

import { diagnose } from "../../cli/app/doctor.ts";
import { applyGc, planGc } from "../../cli/app/gc.ts";
import { initRepository } from "../../cli/app/init.ts";
import { BatchRequestError, type GitHubCli, type GlobalGitConfig, type LfsClient } from "../../cli/app/ports.ts";
import { listTrash, restoreObjects, selectTrash } from "../../cli/app/restore.ts";
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

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("gc", () => {
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

  it("flags the shared layout without other repositories", async () => {
    const s = scenario();
    cleanup.push(() => s.repo.remove());
    s.client.serverInfo.storageLayout = "shared";
    const plan = await planGc(
      { repo: s.git, otherRepos: [], client: s.client, bucket: s.bucket, reporter: new SilentReporter() },
      { fetch: false },
    );
    expect(plan.sharedWithoutRepos).toBe(true);
    expect(plan.prefix).toBe("_shared/");
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
