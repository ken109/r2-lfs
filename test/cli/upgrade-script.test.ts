import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "upgrade-from-upstream.sh");
const IDENTITY = ["-c", "user.name=test", "-c", "user.email=test@example.com"];

const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: "pipe" });

function write(dir: string, files: Record<string, string | null>) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path);
    if (content === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
}

const pkg = (version: string) => `${JSON.stringify({ name: "r2-lfs", version }, null, 2)}\n`;
const wrangler = (name: string, extra = "") => `{\n  "name": "${name}",\n  "main": "worker/index.js",\n${extra}  "vars": {}\n}\n`;
const lines = (...items: string[]) => `${items.join("\n")}\n`;

const V1 = {
  "package.json": pkg("0.1.0"),
  "wrangler.jsonc": wrangler("r2-lfs"),
  "src/app.ts": lines("one", "two", "three", "four", "five", "six", "seven"),
  "src/old.ts": "gone in 0.2.0\n",
  ".github/workflows/ci.yml": "name: CI\n",
};
const V2 = {
  "package.json": pkg("0.2.0"),
  "wrangler.jsonc": wrangler("r2-lfs", '  "migrations": [{ "tag": "v1" }],\n'),
  "src/app.ts": lines("one", "two", "three", "four", "five", "six", "SEVEN"),
  "src/old.ts": null,
  "src/new.ts": "added in 0.2.0\n",
  ".github/workflows/ci.yml": "name: CI v2\n",
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** r2-lfs with two releases, and a copy of the first as the Deploy to Cloudflare button makes it: one commit, no history. */
function setup(localEdits: Record<string, string | null>) {
  const root = mkdtempSync(join(tmpdir(), "r2-lfs-upgrade-"));
  dirs.push(root);
  const upstream = join(root, "upstream");
  const copy = join(root, "copy");
  for (const dir of [upstream, copy]) {
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
  }
  write(upstream, V1);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "0.1.0");
  git(upstream, "tag", "v0.1.0");
  git(upstream, "tag", "v0");
  write(upstream, V2);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "0.2.0");
  git(upstream, "tag", "v0.2.0");

  write(copy, { ...V1, ...localEdits });
  git(copy, "add", "-A");
  git(copy, "commit", "-q", "-m", "Initial commit");
  return { upstream, copy, run: () => runScript(copy, upstream) };
}

function runScript(cwd: string, upstream: string) {
  const outputFile = join(cwd, "..", "github-output");
  writeFileSync(outputFile, "");
  execFileSync("bash", [SCRIPT], { cwd, stdio: "pipe", env: { ...process.env, UPSTREAM_URL: upstream, GITHUB_OUTPUT: outputFile } });
  return Object.fromEntries(
    readFileSync(outputFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

describe.skipIf(process.platform === "win32")("upgrade-from-upstream.sh", () => {
  it("applies the next release on a branch, keeping the copy's own changes", () => {
    const { copy, run } = setup({
      "wrangler.jsonc": wrangler("my-lfs"),
      "src/app.ts": lines("ONE", "two", "three", "four", "five", "six", "seven"),
    });
    expect(run()).toEqual({ version: "v0.2.0", branch: "r2-lfs-upgrade/v0.2.0", conflicts: "", workflows: ".github/workflows/ci.yml" });

    const read = (path: string) => readFileSync(join(copy, path), "utf8");
    expect(git(copy, "branch", "--show-current").trim()).toBe("r2-lfs-upgrade/v0.2.0");
    expect(git(copy, "status", "--porcelain")).toBe("");
    expect(JSON.parse(read("package.json")).version).toBe("0.2.0");
    expect(read("wrangler.jsonc")).toBe(wrangler("my-lfs", '  "migrations": [{ "tag": "v1" }],\n'));
    expect(read("src/app.ts")).toBe(lines("ONE", "two", "three", "four", "five", "six", "SEVEN"));
    expect(read("src/new.ts")).toBe("added in 0.2.0\n");
    expect(() => read("src/old.ts")).toThrow(/ENOENT/);
    // GITHUB_TOKEN may not push workflow changes, so they are only reported.
    expect(read(".github/workflows/ci.yml")).toBe("name: CI\n");
    // Upstream tags stay out of the copy's own tags.
    expect(git(copy, "tag")).toBe("");

    git(copy, "switch", "-q", "main");
    git(copy, "merge", "-q", "r2-lfs-upgrade/v0.2.0");
    expect(run()).toEqual({ version: "" });
  });

  it("commits conflicting lines with markers and lists the files", () => {
    const { copy, run } = setup({ "src/app.ts": lines("one", "two", "three", "four", "five", "six", "mine") });
    const result = run();
    expect(result).toMatchObject({ version: "v0.2.0", conflicts: "src/app.ts" });
    const app = readFileSync(join(copy, "src/app.ts"), "utf8");
    expect(app).toContain("<<<<<<<");
    expect(app).toContain("mine");
    expect(app).toContain("SEVEN");
    expect(readFileSync(join(copy, "src/new.ts"), "utf8")).toBe("added in 0.2.0\n");
    expect(git(copy, "status", "--porcelain")).toBe("");
  });

  it("refuses a version that is not an r2-lfs release", () => {
    const { run } = setup({ "package.json": pkg("0.1.5") });
    expect(run).toThrow(/not an r2-lfs release/);
  });
});
