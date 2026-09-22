import { rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { archiveTag } from "../../cli/app/archive.ts";
import type { GitHubCli } from "../../cli/app/ports.ts";
import { Git } from "../../cli/infra/git.ts";
import { LocalFiles } from "../../cli/infra/local-files.ts";
import { cleanups, SilentReporter, TempRepo } from "./helpers.ts";

const cleanup = cleanups();

describe("archive", () => {
  function archiving() {
    const repo = new TempRepo();
    cleanup(() => repo.remove());
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
      token: () => "gho_release",
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
    cleanup(() => rmSync(result.outputDir, { recursive: true, force: true }));
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
    cleanup(() => rmSync(local.outputDir, { recursive: true, force: true }));
    expect(local.published).toBe(false);
  });
});
