import { rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { forgetSession, installCredentialHelper, parseCredentialRequest, passwordFor } from "../../cli/app/credential.ts";
import { LocalFiles } from "../../cli/infra/local-files.ts";
import { cleanups, FakeGitConfig, FakeLfsClient, MemorySessionCache } from "./helpers.ts";

const cleanup = cleanups();

describe("credential helper", () => {
  it("answers with R2_LFS_TOKEN first, then an Actions OIDC token for the audience the server announces", async () => {
    const requested: string[] = [];
    const actions = { available: () => true, request: async (audience: string) => (requested.push(audience), `oidc-for-${audience}`) };
    const client = new FakeLfsClient();
    const origins: string[] = [];
    const connect = (location: { origin: string }) => (origins.push(location.origin), client);
    const rest = { ghToken: () => "gho_never", sessions: new MemorySessionCache(), now: () => new Date() };

    expect(await passwordFor({ token: "from-env", actions, connect, ...rest }, "https://lfs.example.com")).toBe("from-env");
    expect(requested).toEqual([]);

    expect(await passwordFor({ token: undefined, actions, connect, ...rest }, "https://lfs.example.com")).toBeUndefined();
    client.serverInfo = { ...client.serverInfo, actionsOidcAudience: "r2-lfs" };
    expect(await passwordFor({ token: undefined, actions, connect, ...rest }, "https://lfs.example.com")).toBe("oidc-for-r2-lfs");
    expect(origins).toEqual(["https://lfs.example.com", "https://lfs.example.com"]);

    const outside = { available: () => false, request: async () => "never" };
    expect(
      await passwordFor({ token: undefined, actions: outside, connect, ...rest, ghToken: () => undefined }, "https://lfs.example.com"),
    ).toBeUndefined();
    client.info = async () => {
      throw new Error("offline");
    };
    expect(await passwordFor({ token: undefined, actions, connect, ...rest }, "https://lfs.example.com")).toBeUndefined();
  });

  it("trades the gh login for a short-lived token for the repository git names, and reuses it until it nearly expires", async () => {
    const outside = { available: () => false, request: async () => "never" };
    const client = new FakeLfsClient();
    const traded: { url: string; token: string | undefined }[] = [];
    const connect = (location: { url: string }, token: string | undefined) => (traded.push({ url: location.url, token }), client);
    const sessions = new MemorySessionCache();
    let now = new Date("2026-09-14T00:00:00Z");
    const deps = { token: undefined, actions: outside, connect, ghToken: () => "gho_login", sessions, now: () => now };
    const origin = "https://lfs.example.com";

    // An older server has no session endpoint, and git without useHttpPath names no repository: the gh token goes as is.
    expect(await passwordFor(deps, origin, "acme/assets.git/info/lfs")).toBe("gho_login");
    expect(await passwordFor(deps, origin)).toBe("gho_login");

    client.sessionAnswer = { token: "r2lfs-s1.first", expiresAt: new Date("2026-09-14T01:00:00Z") };
    expect(await passwordFor(deps, origin, "acme/assets.git/info/lfs")).toBe("r2lfs-s1.first");
    expect(traded.at(-1)).toEqual({ url: "https://lfs.example.com/acme/assets.git/info/lfs", token: "gho_login" });
    const calls = traded.length;
    now = new Date("2026-09-14T00:45:00Z");
    expect(await passwordFor(deps, origin, "acme/assets")).toBe("r2lfs-s1.first");
    expect(traded).toHaveLength(calls);

    // Within ten minutes of expiring, or after git erased it for a rejection, it trades again.
    now = new Date("2026-09-14T00:55:00Z");
    client.sessionAnswer = { token: "r2lfs-s1.second", expiresAt: new Date("2026-09-14T01:55:00Z") };
    expect(await passwordFor(deps, origin, "acme/assets")).toBe("r2lfs-s1.second");
    forgetSession(sessions, origin, "acme/assets/info/lfs");
    client.sessionAnswer = { token: "r2lfs-s1.third", expiresAt: new Date("2026-09-14T01:55:00Z") };
    expect(await passwordFor(deps, origin, "acme/assets")).toBe("r2lfs-s1.third");

    expect(await passwordFor({ ...deps, ghToken: () => undefined }, origin, "acme/assets")).toBeUndefined();
  });

  it("installs a launcher that git runs with sh, sending the repository's path", () => {
    const files = new LocalFiles();
    const configDir = join(files.tempDir("r2-lfs-credential-"), "r2-lfs");
    cleanup(() => rmSync(configDir, { recursive: true, force: true }));
    const helpers: [string, string][] = [];
    const gitConfig = new FakeGitConfig();
    gitConfig.useCredentialHelper = (origin: string, helper: string) => void helpers.push([origin, helper]);
    const launcher = installCredentialHelper(
      { files, gitConfig, platform: "linux", configDir, join },
      { node: "/usr/bin/node", cli: "/opt/r2-lfs/cli.js" },
      "https://lfs.example.com",
    );
    expect(helpers).toEqual([["https://lfs.example.com", `!sh '${launcher.replaceAll("\\", "/")}'`]]);
    expect(gitConfig.get("credential.https://lfs.example.com.useHttpPath")).toBe("true");
    expect(files.readText(launcher)).toContain('exec r2-lfs credential "$@"');
  });

  it("reads git's credential request", () => {
    expect(Object.fromEntries(parseCredentialRequest("protocol=https\r\nhost=lfs.example.com:8443\npath=a=b\n\n"))).toEqual({
      protocol: "https",
      host: "lfs.example.com:8443",
      path: "a=b",
    });
  });
});
