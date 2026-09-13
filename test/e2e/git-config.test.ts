import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GH_CREDENTIAL_HELPER, UserGitConfig } from "../../cli/infra/global-git-config.ts";
import { assertInContainer } from "./container.ts";

assertInContainer();

const ORIGIN = "https://lfs.example.com";
const globalGit = (...args: string[]) => execFileSync("git", ["config", "--global", ...args], { encoding: "utf8" });

describe("UserGitConfig against the real global git config", () => {
  let bin: string;
  const path = process.env.PATH;

  beforeEach(() => {
    rmSync(join(homedir(), ".gitconfig"), { force: true });
    // A stand-in for the GitHub CLI, so the credential helper has a login to read.
    bin = mkdtempSync(join(tmpdir(), "r2-lfs-bin-"));
    writeFileSync(join(bin, "gh"), '#!/bin/sh\n[ "$1 $2" = "auth token" ] && echo gho_from_gh\n');
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${path}`;
  });

  afterEach(() => {
    process.env.PATH = path;
    delete process.env.R2_LFS_TOKEN;
    rmSync(bin, { recursive: true, force: true });
  });

  it("reads and writes user-level settings", () => {
    const config = new UserGitConfig();
    expect(config.get("r2-lfs.server")).toBeUndefined();
    config.set("r2-lfs.server", ORIGIN);
    expect(config.get("r2-lfs.server")).toBe(ORIGIN);
    expect(globalGit("--get", "r2-lfs.server").trim()).toBe(ORIGIN);
  });

  it("answers git's password prompt with the gh login, ahead of helpers configured earlier", () => {
    const config = new UserGitConfig();
    globalGit("credential.helper", "!f() { echo username=keychain; echo password=from_keychain; }; f");
    expect(config.credentialFor(ORIGIN)).toBe("from_keychain");

    config.useGhCredentials(ORIGIN);
    config.useGhCredentials(ORIGIN);
    // The empty helper resets the list, so helpers configured before it are skipped for this host.
    expect(globalGit("--get-all", `credential.${ORIGIN}.helper`).split("\n").slice(0, -1)).toEqual(["", GH_CREDENTIAL_HELPER]);
    expect(config.helpersFor(ORIGIN)).toEqual([GH_CREDENTIAL_HELPER]);
    expect(config.credentialFor(ORIGIN)).toBe("gho_from_gh");
    // Other hosts keep the helper they had.
    expect(config.credentialFor("https://other.example.com")).toBe("from_keychain");

    process.env.R2_LFS_TOKEN = "from_env";
    expect(config.credentialFor(ORIGIN)).toBe("from_env");
  });

  it("returns nothing instead of prompting when no helper knows the host", () => {
    expect(new UserGitConfig().credentialFor(ORIGIN)).toBeUndefined();
  });
});
