import { rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { diagnose } from "../../cli/app/doctor.ts";
import { initRepository } from "../../cli/app/init.ts";
import { BatchRequestError, type LfsClient } from "../../cli/app/ports.ts";
import { launcherScript, parseLauncher } from "../../cli/domain/launchers.ts";
import { Git } from "../../cli/infra/git.ts";
import { LocalFiles } from "../../cli/infra/local-files.ts";
import { cleanups, FakeGitConfig, FakeLfsClient, noGh, SilentReporter, TempRepo } from "./helpers.ts";

const cleanup = cleanups();

describe("init and doctor", () => {
  it("writes .lfsconfig, tracks presets and probes access", async () => {
    const repo = new TempRepo();
    cleanup(() => repo.remove());
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

    const files = new LocalFiles();
    const configDir = join(files.tempDir("r2-lfs-agent-"), "r2-lfs");
    cleanup(() => rmSync(configDir, { recursive: true, force: true }));
    const target = { node: "/usr/bin/node", cli: "/opt/r2-lfs's/cli.js" };
    await initRepository(
      { repo: git, gitConfig, gh: noGh, reporter: new SilentReporter(), connect: () => client },
      {
        server: "https://lfs.example.com",
        track: [],
        transferAgent: { deps: { files, gitConfig, platform: "linux", configDir, join }, target },
      },
    );
    // git-lfs starts a launcher, not a Node binary a version manager may move.
    const launcher = join(configDir, "transfer-agent");
    expect(gitConfig.get("lfs.customtransfer.r2-lfs-multipart.path")).toBe(launcher);
    expect(gitConfig.get("lfs.customtransfer.r2-lfs-multipart.args")).toBe("");
    expect(gitConfig.get("lfs.customtransfer.r2-lfs-multipart.direction")).toBe("upload");
    expect(parseLauncher(files.readText(launcher) ?? "")).toEqual(target);
  });

  it("validates its inputs, keeps a remembered server and reports when access cannot be checked", async () => {
    const repo = new TempRepo();
    cleanup(() => repo.remove());
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
    cleanup(() => repo.remove());
    repo.git("config", "filter.lfs.process", "git-lfs filter-process");
    const git = Git.open(repo.dir);
    const base = {
      repo: git,
      lfsInstalled: true,
      gitConfig: new FakeGitConfig(),
      gh: noGh,
      r2Configured: false,
      ghHelper: "",
      readText: () => undefined,
      exists: () => false,
      findOnPath: () => undefined,
    };

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
    expect(checks.find((c) => c.name === "locking")).toMatchObject({
      status: "warn",
      fix: "git config -f .lfsconfig lfs.locksverify true",
    });
    expect(checks.find((c) => c.name === "R2 credentials")).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("through the server"),
    });

    readOnly.serverInfo = { ...readOnly.serverInfo, warnings: ["ALLOWED_OWNERS is deprecated"] };
    const warned = await diagnose({ ...base, connect: (): LfsClient => readOnly });
    expect(warned.find((c) => c.name === "server settings")).toMatchObject({ status: "warn", detail: "ALLOWED_OWNERS is deprecated" });

    // What init writes: the server implements locks, so pushes check them.
    repo.write(".lfsconfig", "[lfs]\n\turl = https://lfs.example.com/acme/assets\n\tlocksverify = true\n");
    const locking = await diagnose({ ...base, connect: (): LfsClient => readOnly });
    expect(locking.find((c) => c.name === "locking")).toMatchObject({ status: "ok" });
    expect(locking.find((c) => c.name === "transfer agent")).toBeUndefined();

    // A gh login sent as is shows up in logs; the launcher trades it for short-lived tokens.
    const helpers = new FakeGitConfig();
    let configured: string[] = [];
    helpers.helpersFor = () => configured;
    configured = ["!f() { gh; }; f"];
    const oldHelper = await diagnose({ ...base, gitConfig: helpers, ghHelper: "!f() { gh; }; f", connect: (): LfsClient => readOnly });
    expect(oldHelper.find((c) => c.name === "credentials")).toMatchObject({ status: "warn", fix: "r2-lfs credential --install" });
    configured = ["", "!sh '/home/me/.config/r2-lfs/credential'"];
    const traded = await diagnose({ ...base, gitConfig: helpers, ghHelper: "!f() { gh; }; f", connect: (): LfsClient => readOnly });
    expect(traded.find((c) => c.name === "credentials")).toMatchObject({
      status: "ok",
      detail: "your gh login, traded for short-lived tokens",
    });
  });

  it("checks that git-lfs can still start the transfer agent", async () => {
    const repo = new TempRepo();
    cleanup(() => repo.remove());
    repo.git("config", "filter.lfs.process", "git-lfs filter-process");
    const gitConfig = new FakeGitConfig();
    const launcher = "/home/me/.config/r2-lfs/transfer-agent";
    const script = launcherScript("linux", { node: "/mise/node/24/bin/node", cli: "/mise/node/24/lib/r2-lfs/cli.js" });
    const present = new Set<string>();
    let onPath: string | undefined;
    const agent = async (path: string) => {
      gitConfig.values.set("lfs.customtransfer.r2-lfs-multipart.path", path);
      const checks = await diagnose({
        repo: Git.open(repo.dir),
        lfsInstalled: true,
        gitConfig,
        gh: noGh,
        connect: () => new FakeLfsClient(),
        r2Configured: false,
        ghHelper: "",
        readText: (p) => (p === launcher ? script : undefined),
        exists: (p) => present.has(p),
        findOnPath: (command) => (command === "r2-lfs" ? onPath : undefined),
      });
      return checks.find((c) => c.name === "transfer agent");
    };

    // Node was upgraded away and r2-lfs is not on PATH.
    expect(await agent(launcher)).toMatchObject({ status: "fail", fix: "r2-lfs transfer-agent --install" });
    present.add("/mise/node/24/bin/node").add("/mise/node/24/lib/r2-lfs/cli.js");
    expect(await agent(launcher)).toMatchObject({ status: "ok" });
    present.clear();
    onPath = "/mise/shims/r2-lfs";
    expect(await agent(launcher)).toMatchObject({ status: "ok", detail: "uploads in parts through /mise/shims/r2-lfs" });

    // What versions before the launcher registered: Node itself.
    expect(await agent("/mise/node/22/bin/node")).toMatchObject({ status: "fail" });
    present.add("/mise/node/22/bin/node");
    expect(await agent("/mise/node/22/bin/node")).toMatchObject({ status: "warn", fix: "r2-lfs transfer-agent --install" });
  });
});
