import type { GithubPermissions, Lookup } from "../app/ports.ts";
import { permissionFromGithub } from "../domain/access.ts";
import type { Repo } from "../domain/repo.ts";
import { sha256Hex } from "./crypto.ts";

export type Fetcher = (input: Request | string, init?: RequestInit) => Promise<Response>;

const TTL_MS = 60_000;
const MAX_ENTRIES = 1_000;
// Per isolate. A batch call and the transfers that follow it usually land on the same isolate.
const cache = new Map<string, { lookup: Lookup & { ok: true }; expires: number }>();

export function clearGithubCache(): void {
  cache.clear();
}

/** Mirrors a repository's GitHub permissions for the account that owns the token. */
export class GithubApiPermissions implements GithubPermissions {
  private readonly fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    this.fetcher = fetcher;
  }

  async lookup(repo: Repo, token: string): Promise<Lookup> {
    const key = `${await sha256Hex(token)}:${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.lookup;

    let res: Response;
    try {
      res = await this.fetcher(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "r2-lfs",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        // A renamed or transferred repository redirects to its new owner, which ALLOWED_REPOS may not allow.
        redirect: "manual",
      });
    } catch {
      return { ok: false, status: 502, message: "Could not reach the GitHub API" };
    }
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: 404, message: "Repository not found; if it was renamed or transferred, update lfs.url" };
    }
    if (res.status === 401) return { ok: false, status: 401, message: "GitHub rejected the token" };
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      return { ok: false, status: 503, message: "GitHub API rate limit reached; try again later" };
    }
    if (res.status === 403 && res.headers.has("x-github-sso")) {
      return { ok: false, status: 403, message: "Authorize this token for the organization's SAML single sign-on" };
    }
    // GitHub hides private repositories the token cannot see behind 404.
    if (res.status === 403 || res.status === 404) {
      return { ok: false, status: 404, message: "Repository not found or not accessible with this token" };
    }
    if (!res.ok) return { ok: false, status: 502, message: `GitHub API returned ${res.status}` };

    const body = (await res.json()) as { permissions?: { push?: boolean; pull?: boolean } };
    const lookup = { ok: true as const, permission: permissionFromGithub(body.permissions) };
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(key, { lookup, expires: Date.now() + TTL_MS });
    return lookup;
  }
}
