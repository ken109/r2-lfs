import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { workerConfig } from "../../cli/app/setup.ts";
import { assertInContainer } from "./container.ts";

assertInContainer();

const CLI = join(process.cwd(), "dist", "cli.js");
const PORT = 8787;
const SERVER = `http://127.0.0.1:${PORT}`;
const TOKEN = "e2e-token-0123456789abcdef";

const run = (cmd: string, args: string[], cwd?: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (cwd: string, ...args: string[]) => run("git", args, cwd);
const cli = (cwd: string, ...args: string[]) => run("node", [CLI, ...args], cwd);

/**
 * fetch against wrangler dev, trying once more when a kept-alive connection was closed by the server just as it
 * was reused; the request never reached the Worker then.
 */
async function serverFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${SERVER}${path}`, init);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return fetch(`${SERVER}${path}`, init);
  }
}

describe("git-lfs through a local r2-lfs server", () => {
  let work: string;
  let server: ChildProcess;
  let serverLog = "";

  beforeAll(async () => {
    rmSync(join(homedir(), ".gitconfig"), { force: true });
    execFileSync("git", ["config", "--global", "user.name", "e2e"]);
    execFileSync("git", ["config", "--global", "user.email", "e2e@example.com"]);
    execFileSync("git", ["config", "--global", "init.defaultBranch", "main"]);
    execFileSync("git", ["lfs", "install", "--skip-repo"]);
    // What a password manager would answer for the server.
    execFileSync("git", ["config", "--global", `credential.${SERVER}.helper`, `!f() { echo username=e2e; echo password=${TOKEN}; }; f`]);

    work = mkdtempSync(join(tmpdir(), "r2-lfs-e2e-"));
    const envFile = join(work, "worker.env");
    writeFileSync(
      envFile,
      `ALLOWED_REPOS=acme/*\nAUTH_MODE=token\nTRANSFER_MODE=proxy\nPROXY_MAX_UPLOAD_MB=5\nAUTH_TOKENS=acme/*:rw:${TOKEN}\n`,
    );
    // The Worker as the npm package ships it and `r2-lfs setup` deploys it.
    const site = join(work, "site");
    cpSync(join(process.cwd(), "dist", "worker"), join(site, "worker"), { recursive: true });
    cpSync(join(process.cwd(), "dist", "public"), join(site, "public"), { recursive: true });
    const config = workerConfig({
      name: "r2-lfs-e2e",
      bucket: "r2-lfs-e2e",
      repos: ["acme/*"],
      authMode: "token",
      layout: "per-repo",
      lockDays: 0,
      trashDays: 0,
      deploy: true,
    });
    writeFileSync(join(site, "wrangler.json"), JSON.stringify(config));
    server = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--config",
        join(site, "wrangler.json"),
        "--ip",
        "127.0.0.1",
        "--port",
        String(PORT),
        "--show-interactive-dev-session=false",
        "--env-file",
        envFile,
        "--persist-to",
        join(work, "state"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    server.stdout?.on("data", (chunk: Buffer) => (serverLog += chunk.toString()));
    server.stderr?.on("data", (chunk: Buffer) => (serverLog += chunk.toString()));

    const deadline = Date.now() + 90_000;
    for (;;) {
      const ok = await fetch(`${SERVER}/_r2-lfs/info`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      if (Date.now() > deadline) throw new Error(`wrangler dev did not start:\n${serverLog}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  // The Worker's own errors explain a failed git command far better than git-lfs's "Server error".
  afterEach((ctx) => {
    if (ctx.task.result?.state === "fail") console.error(`wrangler dev output:\n${serverLog}`);
    serverLog = "";
  });

  afterAll(() => {
    server?.kill();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("keeps the admin UI closed while Cloudflare Access is not configured", async () => {
    const res = await serverFetch("/_admin");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Cloudflare Access");
    expect((await serverFetch("/_admin/_serverFn/anything", { method: "POST" })).status).toBe(404);
  });

  it("sets a repository up with init, pushes LFS files and clones them back", () => {
    const origin = join(work, "origin.git");
    git(work, "init", "-q", "--bare", origin);
    const repo = join(work, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", origin);

    cli(repo, "init", "--server", SERVER, "--repo", "acme/assets", "--track", "blender", "--credential", "none");
    expect(git(repo, "config", "--global", "--get", "r2-lfs.server").trim()).toBe(SERVER);

    const scene = randomBytes(256 * 1024);
    writeFileSync(join(repo, "scene.blend"), scene);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "scene");
    git(repo, "push", "-q", "origin", "main");
    expect(git(repo, "lfs", "ls-files")).toContain("scene.blend");

    const clone = join(work, "clone");
    git(work, "clone", "-q", origin, clone);
    expect(readFileSync(join(clone, "scene.blend")).equals(scene)).toBe(true);

    // File locks through git-lfs itself: lock, see the holder, push while holding it, unlock.
    git(repo, "lfs", "lock", "scene.blend");
    const locks = JSON.parse(git(repo, "lfs", "locks", "--json")) as { path: string; owner: { name: string } }[];
    expect(locks).toEqual([expect.objectContaining({ path: "scene.blend", owner: { name: "AUTH_TOKENS #1" } })]);
    writeFileSync(join(repo, "scene.blend"), randomBytes(1024));
    git(repo, "commit", "-q", "-am", "edit while locked");
    git(repo, "push", "-q", "origin", "main");
    git(repo, "lfs", "unlock", "scene.blend");
    expect(JSON.parse(git(repo, "lfs", "locks", "--json"))).toEqual([]);

    const verified = JSON.parse(cli(repo, "verify", "--json")) as { checked: number; missing: unknown[] };
    expect(verified).toMatchObject({ checked: 1, missing: [] });
    const checks = JSON.parse(cli(repo, "doctor", "--json")) as { name: string; status: string }[];
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.find((c) => c.name === "access")?.status).toBe("ok");
  });

  it("uploads objects past the proxy request limit through the transfer agent", () => {
    const origin = join(work, "big-origin.git");
    git(work, "init", "-q", "--bare", origin);
    const repo = join(work, "big");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "remote", "add", "origin", origin);
    cli(repo, "init", "--server", SERVER, "--repo", "acme/big", "--track", "blender", "--credential", "none", "--transfer-agent");
    expect(git(repo, "config", "--global", "--get", "lfs.customtransfer.r2-lfs-multipart.args")).toContain("transfer-agent");

    // PROXY_MAX_UPLOAD_MB is 5, so basic transfers would refuse this; the agent sends it in three parts.
    const scene = randomBytes(12 * 1024 * 1024);
    writeFileSync(join(repo, "big.blend"), scene);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "big");
    git(repo, "push", "-q", "origin", "main");
    expect(readdirSync(join(repo, ".git", "lfs", "r2-lfs", "uploads"))).toEqual([]);

    const clone = join(work, "big-clone");
    git(work, "clone", "-q", origin, clone);
    expect(readFileSync(join(clone, "big.blend")).equals(scene)).toBe(true);
  });

  it("migrates the objects of every branch, including branches this clone has not checked out", async () => {
    const origin = join(work, "migrate-origin.git");
    git(work, "init", "-q", "--bare", origin);
    const author = join(work, "migrate-author");
    mkdirSync(author);
    git(author, "init", "-q");
    git(author, "remote", "add", "origin", origin);
    cli(author, "init", "--server", SERVER, "--repo", "acme/old", "--track", "blender", "--credential", "none");
    writeFileSync(join(author, "main.blend"), randomBytes(64 * 1024));
    git(author, "add", "-A");
    git(author, "commit", "-q", "-m", "main");
    git(author, "push", "-q", "origin", "main");
    git(author, "switch", "-q", "-c", "feature");
    const feature = randomBytes(64 * 1024);
    writeFileSync(join(author, "feature.blend"), feature);
    git(author, "add", "-A");
    git(author, "commit", "-q", "-m", "feature");
    git(author, "push", "-q", "origin", "feature");

    // A fresh clone has only main locally; feature exists as a remote-tracking branch.
    const clone = join(work, "migrate-clone");
    git(work, "clone", "-q", origin, clone);
    cli(clone, "migrate", "--server", SERVER, "--repo", "acme/new", "--from", `${SERVER}/acme/old`, "--credential", "none");

    const oid = createHash("sha256").update(feature).digest("hex");
    const res = await serverFetch("/acme/new/objects/batch", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`e2e:${TOKEN}`)}`, "Content-Type": "application/vnd.git-lfs+json" },
      body: JSON.stringify({ operation: "download", objects: [{ oid, size: feature.length }] }),
    });
    const body = (await res.json()) as { objects: { error?: unknown; actions?: unknown }[] };
    expect(body.objects[0]).toMatchObject({ actions: expect.anything() });
    expect(body.objects[0]?.error).toBeUndefined();
  });
});
