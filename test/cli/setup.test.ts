import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { setupServer } from "../../cli/app/setup.ts";
import { FakeWrangler, RecordingFiles, SilentReporter } from "./helpers.ts";

const TEMP = "/tmp/with space/r2-lfs-setup-1";

function setupFakes() {
  const wrangler = new FakeWrangler();
  const files = new RecordingFiles(TEMP);
  return {
    runs: wrangler.runs,
    written: files.written,
    copied: files.copied,
    deps: { wrangler, files, reporter: new SilentReporter(), workerFiles: { worker: "dist/worker", assets: "dist/public" } },
  };
}

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
    expect(f.runs.at(-1)?.cwd).toBe(TEMP);
    const config = JSON.parse(f.written.get(join(TEMP, "wrangler.json"))!) as { vars: Record<string, string> };
    // The account Wrangler deploys to, which presigned URLs and the admin UI's activity page need.
    expect(config.vars).toMatchObject({ ALLOWED_REPOS: "acme/*", R2_ACCOUNT_ID: "acc123", R2_BUCKET_NAME: "lfs" });
    expect(f.copied).toEqual([`dist/worker -> ${join(TEMP, "worker")}`, `dist/public -> ${join(TEMP, "public")}`]);
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
