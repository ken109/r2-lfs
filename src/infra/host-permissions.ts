import type { Credentials, HostPermissions, Lookup } from "../app/ports.ts";
import { type Permission, permissionFromBitbucket, permissionFromGithub, permissionFromGitlab } from "../domain/access.ts";
import type { HostSettings } from "../domain/config.ts";
import type { Repo } from "../domain/repo.ts";
import { sha256Hex } from "./crypto.ts";

export type Fetcher = (input: Request | string, init?: RequestInit) => Promise<Response>;

const TTL_MS = 60_000;
const MAX_ENTRIES = 1_000;
// Per isolate. A batch call and the transfers that follow it usually land on the same isolate.
const lookups = new Map<string, { lookup: Lookup & { ok: true }; expires: number }>();
const logins = new Map<string, { login: string; expires: number }>();

export function clearHostCache(): void {
  lookups.clear();
  logins.clear();
}

function remember<V>(cache: Map<string, { expires: number } & V>, key: string, value: V): void {
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { ...value, expires: Date.now() + TTL_MS });
}

/** How one kind of host answers "what may this account do in this repository" and "who is this". */
interface HostApi {
  readonly name: string;
  headers(credentials: Credentials): Record<string, string>;
  repositoryUrl(repo: Repo): string;
  /** The permission from a successful repository response; `undefined` when the account cannot see it. */
  permission(body: unknown, repo: Repo, credentials: Credentials): Promise<Permission | undefined>;
  userUrl: string;
  login(body: unknown): string | undefined;
  /** The repository's immutable id in a successful repository response. */
  id(body: unknown): string | undefined;
}

const path = (repo: Repo) => `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const numericId = (body: unknown) => {
  const id = (body as { id?: unknown }).id;
  return typeof id === "number" || typeof id === "string" ? String(id) : undefined;
};

function githubApi(apiBase: string): HostApi {
  return {
    name: "GitHub",
    headers: (c) => ({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${c.password}`,
      "X-GitHub-Api-Version": "2022-11-28",
    }),
    repositoryUrl: (repo) => `${apiBase}/repos/${path(repo)}`,
    permission: async (body) => permissionFromGithub((body as { permissions?: Parameters<typeof permissionFromGithub>[0] }).permissions),
    userUrl: `${apiBase}/user`,
    login: (body) => str((body as { login?: unknown }).login),
    id: numericId,
  };
}

function giteaApi(host: string): HostApi {
  return {
    name: "Gitea",
    headers: (c) => ({ Accept: "application/json", Authorization: `token ${c.password}` }),
    repositoryUrl: (repo) => `${host}/api/v1/repos/${path(repo)}`,
    // Gitea and Forgejo describe the account's role with GitHub's shape.
    permission: async (body) => permissionFromGithub((body as { permissions?: Parameters<typeof permissionFromGithub>[0] }).permissions),
    userUrl: `${host}/api/v1/user`,
    login: (body) => str((body as { login?: unknown }).login),
    id: numericId,
  };
}

function gitlabApi(host: string): HostApi {
  return {
    name: "GitLab",
    headers: (c) => ({ Accept: "application/json", Authorization: `Bearer ${c.password}` }),
    repositoryUrl: (repo) => `${host}/api/v4/projects/${encodeURIComponent(`${repo.owner}/${repo.name}`)}`,
    permission: async (body) => permissionFromGitlab(body as Parameters<typeof permissionFromGitlab>[0]),
    userUrl: `${host}/api/v4/user`,
    login: (body) => str((body as { username?: unknown }).username),
    id: numericId,
  };
}

// App passwords go with the username; access tokens alone.
const bitbucketHeaders = (c: Credentials) => ({
  Accept: "application/json",
  Authorization: c.username ? `Basic ${btoa(`${c.username}:${c.password}`)}` : `Bearer ${c.password}`,
});

function bitbucketApi(fetcher: Fetcher): HostApi {
  const base = "https://api.bitbucket.org/2.0";
  const headers = bitbucketHeaders;
  return {
    name: "Bitbucket",
    headers,
    repositoryUrl: (repo) => `${base}/repositories/${path(repo)}`,
    permission: async (body, repo, credentials) => {
      const query = encodeURIComponent(`repository.full_name="${repo.owner}/${repo.name}"`);
      const res = await fetcher(`${base}/user/permissions/repositories?q=${query}`, { headers: headers(credentials) }).catch(
        () => undefined,
      );
      const values = res?.ok ? ((await res.json()) as { values?: { permission?: string }[] }).values : undefined;
      const granted = permissionFromBitbucket(values?.[0]?.permission);
      // Anyone may read a public repository.
      return granted === "none" && (body as { is_private?: unknown }).is_private === false ? "read" : granted;
    },
    userUrl: `${base}/user`,
    login: (body) => str((body as { username?: unknown }).username) ?? str((body as { nickname?: unknown }).nickname),
    id: (body) => str((body as { uuid?: unknown }).uuid),
  };
}

/** Mirrors an account's permissions on the repository of the same owner and name at a Git host. */
export class RemoteHostPermissions implements HostPermissions {
  private readonly fetcher: Fetcher;
  private readonly api: HostApi;
  private readonly cacheScope: string;

  constructor(fetcher: Fetcher, host: HostSettings) {
    this.fetcher = fetcher;
    this.cacheScope = `${host.kind}:${host.url}`;
    this.api =
      host.kind === "gitlab"
        ? gitlabApi(host.url)
        : host.kind === "gitea"
          ? giteaApi(host.url)
          : host.kind === "bitbucket"
            ? bitbucketApi(fetcher)
            : githubApi(host.url === "https://github.com" ? "https://api.github.com" : `${host.url}/api/v3`);
  }

  private async cacheKey(credentials: Credentials, suffix: string): Promise<string> {
    return `${this.cacheScope}:${await sha256Hex(`${credentials.username ?? ""}:${credentials.password}`)}:${suffix}`;
  }

  async lookup(repo: Repo, credentials: Credentials): Promise<Lookup> {
    const key = await this.cacheKey(credentials, `${repo.owner}/${repo.name}`.toLowerCase());
    const hit = lookups.get(key);
    if (hit && hit.expires > Date.now()) return hit.lookup;

    const name = this.api.name;
    let res: Response;
    try {
      res = await this.fetcher(this.api.repositoryUrl(repo), {
        headers: { ...this.api.headers(credentials), "User-Agent": "r2-lfs" },
        // A renamed or transferred repository redirects to its new owner, which ALLOWED_REPOS may not allow.
        redirect: "manual",
      });
    } catch {
      return { ok: false, status: 502, message: `Could not reach the ${name} API` };
    }
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: 404, message: "Repository not found; if it was renamed or transferred, update lfs.url" };
    }
    if (res.status === 401) return { ok: false, status: 401, message: `${name} rejected the token` };
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      return { ok: false, status: 503, message: `${name} API rate limit reached; try again later` };
    }
    if (res.status === 403 && res.headers.has("x-github-sso")) {
      return { ok: false, status: 403, message: "Authorize this token for the organization's SAML single sign-on" };
    }
    // Hosts hide private repositories the token cannot see behind 404.
    if (res.status === 403 || res.status === 404) {
      return { ok: false, status: 404, message: "Repository not found or not accessible with this token" };
    }
    if (!res.ok) return { ok: false, status: 502, message: `${name} API returned ${res.status}` };

    const body: unknown = await res.json();
    const permission = (await this.api.permission(body, repo, credentials)) ?? "none";
    const repositoryId = this.api.id(body);
    const lookup = { ok: true as const, permission, ...(repositoryId === undefined ? {} : { repositoryId }) };
    remember(lookups, key, { lookup });
    return lookup;
  }

  async login(credentials: Credentials): Promise<string | undefined> {
    const key = await this.cacheKey(credentials, "user");
    const hit = logins.get(key);
    if (hit && hit.expires > Date.now()) return hit.login;
    const res = await this.fetcher(this.api.userUrl, { headers: { ...this.api.headers(credentials), "User-Agent": "r2-lfs" } }).catch(
      () => undefined,
    );
    if (!res?.ok) return undefined;
    const login = this.api.login(await res.json());
    if (login) remember(logins, key, { login });
    return login;
  }
}
