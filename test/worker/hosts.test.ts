import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../src/domain/config.ts";
import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";
import { clearHostCache, type Fetcher } from "../../src/infra/host-permissions.ts";
import { clearRepositoryIdentitiesCache } from "../../src/infra/r2-repository-identities.ts";
import type { LfsLock } from "../../src/shared/contract.ts";

const makeEnv = (over: Partial<Env>): Env => ({
  BUCKET: env.BUCKET,
  LOCKS: env.LOCKS,
  ALLOWED_REPOS: "acme/*",
  TRANSFER_MODE: "proxy",
  ...over,
});

/** A fake host API: answers by URL, and records what was asked with which Authorization header. */
function host(routes: Record<string, unknown | ((request: Request) => Response)>) {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, authorization: request.headers.get("Authorization") });
    const route = routes[request.url];
    if (route === undefined) return new Response("{}", { status: 404 });
    return typeof route === "function" ? (route as (r: Request) => Response)(request) : Response.json(route);
  };
  return { calls, fetcher };
}

async function lfs(e: Env, fetcher: Fetcher, operation: "upload" | "download", authorization: string, repo = "/acme/assets") {
  const res = await handle(
    new Request(`https://lfs.example.com${repo}/objects/batch`, {
      method: "POST",
      headers: { Authorization: authorization },
      body: JSON.stringify({ operation, objects: [] }),
    }),
    e,
    { fetch: fetcher },
  );
  return res.status;
}

const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

beforeEach(() => {
  clearHostCache();
  clearRepositoryIdentitiesCache();
});

describe("GitLab", () => {
  it("maps access levels and public visibility, on gitlab.com or a self-managed host", async () => {
    const project = "https://gitlab.com/api/v4/projects/acme%2Fassets";
    const reporter = host({
      [project]: { visibility: "private", permissions: { project_access: { access_level: 20 }, group_access: null } },
    });
    expect(await lfs(makeEnv({ AUTH_MODE: "gitlab" }), reporter.fetcher, "download", basic("oauth2", "glpat-a"))).toBe(200);
    expect(await lfs(makeEnv({ AUTH_MODE: "gitlab" }), reporter.fetcher, "upload", basic("oauth2", "glpat-a"))).toBe(403);
    expect(reporter.calls[0]).toEqual({ url: project, authorization: "Bearer glpat-a" });

    const developer = host({ [project]: { permissions: { project_access: null, group_access: { access_level: 30 } } } });
    expect(await lfs(makeEnv({ AUTH_MODE: "gitlab" }), developer.fetcher, "upload", basic("oauth2", "glpat-b"))).toBe(200);

    const selfManaged = "https://git.example.com/api/v4/projects/acme%2Fassets";
    const visitor = host({ [selfManaged]: { visibility: "public", permissions: { project_access: null, group_access: null } } });
    const e = makeEnv({ AUTH_MODE: "gitlab", AUTH_HOST: "git.example.com" });
    expect(await lfs(e, visitor.fetcher, "download", basic("oauth2", "glpat-c"))).toBe(200);
    expect(await lfs(e, visitor.fetcher, "upload", basic("oauth2", "glpat-c"))).toBe(403);
  });

  it("names lock holders by GitLab username and lets maintainers force-unlock", async () => {
    const project = "https://gitlab.com/api/v4/projects/acme%2Fgitlab-locks";
    const user = "https://gitlab.com/api/v4/user";
    const e = makeEnv({ AUTH_MODE: "gitlab" });
    const call = (fetcher: Fetcher, token: string, path: string, json: unknown) =>
      handle(
        new Request(`https://lfs.example.com/acme/gitlab-locks${path}`, {
          method: "POST",
          headers: { Authorization: basic("x", token) },
          body: JSON.stringify(json),
        }),
        e,
        {
          fetch: fetcher,
        },
      );
    const dev = host({ [project]: { permissions: { project_access: { access_level: 30 } } }, [user]: { username: "dev" } });
    const res = await call(dev.fetcher, "dev-token", "/locks", { path: `model-${Date.now()}.blend` });
    const lock = ((await res.json()) as { lock: LfsLock }).lock;
    expect(lock.owner.name).toBe("dev");
    const maintainer = host({ [project]: { permissions: { project_access: { access_level: 40 } } }, [user]: { username: "lead" } });
    expect((await call(maintainer.fetcher, "lead-token", `/locks/${lock.id}/unlock`, { force: true })).status).toBe(200);
  });
});

describe("Gitea and Forgejo", () => {
  it("reads GitHub-shaped permissions from the Gitea API with a token header", async () => {
    const repo = "https://code.example.com/api/v1/repos/acme/assets";
    const gitea = host({ [repo]: { permissions: { admin: false, push: true, pull: true } } });
    const e = makeEnv({ AUTH_MODE: "gitea", AUTH_HOST: "https://code.example.com/" });
    expect(await lfs(e, gitea.fetcher, "upload", basic("me", "gitea-token"))).toBe(200);
    expect(gitea.calls[0]).toEqual({ url: repo, authorization: "token gitea-token" });
  });
});

describe("Bitbucket Cloud", () => {
  const repoUrl = "https://api.bitbucket.org/2.0/repositories/acme/assets";
  const permissionsUrl = `https://api.bitbucket.org/2.0/user/permissions/repositories?q=${encodeURIComponent('repository.full_name="acme/assets"')}`;

  it("sends app passwords with the username and reads the account's permission", async () => {
    const bitbucket = host({ [repoUrl]: { is_private: true }, [permissionsUrl]: { values: [{ permission: "write" }] } });
    const e = makeEnv({ AUTH_MODE: "bitbucket" });
    expect(await lfs(e, bitbucket.fetcher, "upload", basic("alice", "app-password"))).toBe(200);
    expect(bitbucket.calls.map((c) => c.authorization)).toEqual([basic("alice", "app-password"), basic("alice", "app-password")]);
  });

  it("lets anyone read a public repository and nobody read a private one without a permission", async () => {
    const e = makeEnv({ AUTH_MODE: "bitbucket" });
    const open = host({ [repoUrl]: { is_private: false }, [permissionsUrl]: { values: [] } });
    expect(await lfs(e, open.fetcher, "download", "Bearer access-token")).toBe(200);
    expect(open.calls[0]?.authorization).toBe("Bearer access-token");
    expect(await lfs(e, open.fetcher, "upload", "Bearer access-token")).toBe(403);
    clearHostCache();
    const closed = host({ [repoUrl]: { is_private: true }, [permissionsUrl]: { values: [] } });
    expect(await lfs(e, closed.fetcher, "download", "Bearer access-token")).toBe(403);
  });
});

describe("repository identity", () => {
  it("refuses a repository that reuses the name of the one whose objects the server keeps", async () => {
    const url = "https://api.github.com/repos/acme/reused";
    const e = makeEnv({ AUTH_MODE: "github" });
    const original = host({ [url]: { id: 101, permissions: { push: true, pull: true } } });
    expect(await lfs(e, original.fetcher, "upload", basic("x", "ghp_original"), "/acme/reused")).toBe(200);
    expect(await (await env.BUCKET.get("_repos/acme/reused"))?.text()).toBe("101");

    // The original was deleted or renamed, and someone else created a repository with its name.
    clearHostCache();
    clearRepositoryIdentitiesCache();
    const impostor = host({ [url]: { id: 202, permissions: { admin: true, push: true, pull: true } } });
    const refused = await handle(
      new Request("https://lfs.example.com/acme/reused/objects/batch", {
        method: "POST",
        headers: { Authorization: basic("x", "ghp_impostor") },
        body: JSON.stringify({ operation: "download", objects: [] }),
      }),
      e,
      { fetch: impostor.fetcher },
    );
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("_repos/acme/reused");

    // The record is per name whatever its case, and the original still works.
    const upper = host({ "https://api.github.com/repos/ACME/Reused": { id: 202, permissions: { pull: true } } });
    expect(await lfs(e, upper.fetcher, "download", basic("x", "ghp_impostor"), "/ACME/Reused")).toBe(403);
    expect(await lfs(e, original.fetcher, "download", basic("x", "ghp_original"), "/acme/reused")).toBe(200);

    // Deleting the record hands the name to whichever repository uses it next.
    await env.BUCKET.delete("_repos/acme/reused");
    clearRepositoryIdentitiesCache();
    clearHostCache();
    expect(await lfs(e, impostor.fetcher, "download", basic("x", "ghp_impostor"), "/acme/reused")).toBe(200);
  });

  it("records nothing for hosts that report no id and for accounts that cannot see the repository", async () => {
    const url = "https://api.github.com/repos/acme/unseen";
    const e = makeEnv({ AUTH_MODE: "github" });
    expect(
      await lfs(e, host({ [url]: () => new Response("{}", { status: 404 }) }).fetcher, "download", basic("x", "a"), "/acme/unseen"),
    ).toBe(404);
    expect(await lfs(e, host({ [url]: { permissions: { pull: true } } }).fetcher, "download", basic("x", "b"), "/acme/unseen")).toBe(200);
    expect(await env.BUCKET.head("_repos/acme/unseen")).toBeNull();
  });
});

describe("GitHub Enterprise Server and host settings", () => {
  it("asks the enterprise host's /api/v3", async () => {
    const repo = "https://ghe.example.com/api/v3/repos/acme/assets";
    const ghes = host({ [repo]: { permissions: { push: true, pull: true } } });
    expect(
      await lfs(makeEnv({ AUTH_MODE: "github", AUTH_HOST: "https://ghe.example.com" }), ghes.fetcher, "upload", basic("x", "ghp_x")),
    ).toBe(200);
  });

  it("requires a host for Gitea and refuses one for Bitbucket Cloud", () => {
    expect(() => parseConfig(makeEnv({ AUTH_MODE: "gitea" }))).toThrow(/AUTH_MODE=gitea needs AUTH_HOST/);
    expect(() => parseConfig(makeEnv({ AUTH_MODE: "bitbucket", AUTH_HOST: "bitbucket.example.com" }))).toThrow(/Bitbucket Cloud only/);
    expect(() => parseConfig(makeEnv({ AUTH_MODE: "gitlab", AUTH_HOST: "https://" }))).toThrow(/AUTH_HOST must be a URL/);
    expect(parseConfig(makeEnv({ AUTH_MODE: "gitlab" })).host).toEqual({ kind: "gitlab", url: "https://gitlab.com" });
  });
});
