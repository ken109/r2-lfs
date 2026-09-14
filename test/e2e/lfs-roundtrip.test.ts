import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    writeFileSync(envFile, `ALLOWED_REPOS=acme/*\nAUTH_MODE=token\nTRANSFER_MODE=proxy\nAUTH_TOKENS=acme/*:rw:${TOKEN}\n`);
    server = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
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

  afterAll(() => {
    server?.kill();
    if (work) rmSync(work, { recursive: true, force: true });
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

    const verified = JSON.parse(cli(repo, "verify", "--json")) as { checked: number; missing: unknown[] };
    expect(verified).toMatchObject({ checked: 1, missing: [] });
    const checks = JSON.parse(cli(repo, "doctor", "--json")) as { name: string; status: string }[];
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.find((c) => c.name === "access")?.status).toBe("ok");
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
    const res = await fetch(`${SERVER}/acme/new/objects/batch`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`e2e:${TOKEN}`)}`, "Content-Type": "application/vnd.git-lfs+json" },
      body: JSON.stringify({ operation: "download", objects: [{ oid, size: feature.length }] }),
    });
    const body = (await res.json()) as { objects: { error?: unknown; actions?: unknown }[] };
    expect(body.objects[0]).toMatchObject({ actions: expect.anything() });
    expect(body.objects[0]?.error).toBeUndefined();
  });
});
