import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { migrate } from "../../cli/app/migrate.ts";
import { Git } from "../../cli/infra/git.ts";
import { cleanups, FakeGitConfig, FakeLfsClient, noGh, SilentReporter, TempRepo } from "./helpers.ts";

const cleanup = cleanups();

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
    cleanup(
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
    cleanup(() => shallow.remove());
    await expect(migrate({ ...m.deps, repo: Git.open(shallow.dir) }, m.opts)).rejects.toThrow(/shallow/);
    expect(m.calls).toEqual([]);
  });
});
