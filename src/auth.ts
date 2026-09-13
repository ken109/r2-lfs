import type { Config, Permission } from "./config.ts";

export interface Repo {
  /** As written in the URL; used for GitHub API calls. */
  owner: string;
  name: string;
}

export type AuthResult =
  | { ok: true; permission: Permission }
  | { ok: false; status: 401 | 404 | 502; message: string };

export type Fetcher = (input: Request | string, init?: RequestInit) => Promise<Response>;

const encoder = new TextEncoder();

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(text));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares digests so neither length nor content leaks through timing. */
async function secretEquals(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(da, db);
}

/** Git LFS sends HTTP Basic credentials from the credential helper; the password is the token. */
export function extractToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const [scheme, credentials] = header.split(" ", 2);
  if (!credentials) return undefined;
  if (scheme?.toLowerCase() === "bearer") return credentials;
  if (scheme?.toLowerCase() !== "basic") return undefined;
  let decoded: string;
  try {
    decoded = atob(credentials);
  } catch {
    return undefined;
  }
  const sep = decoded.indexOf(":");
  const password = sep === -1 ? decoded : decoded.slice(sep + 1);
  return password || undefined;
}

export function ownerAllowed(config: Config, owner: string): boolean {
  return config.allowedOwners === "*" || config.allowedOwners.has(owner.toLowerCase());
}

async function authorizeToken(config: Config, repo: Repo, token: string): Promise<AuthResult> {
  const owner = repo.owner.toLowerCase();
  const full = `${owner}/${repo.name.toLowerCase()}`;
  let permission: Permission = "none";
  let matched = false;
  for (const grant of config.tokens) {
    const inScope = grant.scope === "*" || grant.scope === full || grant.scope === `${owner}/*`;
    // Compare every grant regardless of scope so timing does not reveal which scopes exist.
    if ((await secretEquals(grant.token, token)) && inScope) {
      matched = true;
      if (grant.permission === "write") permission = "write";
      else if (permission === "none") permission = "read";
    }
  }
  if (!matched) return { ok: false, status: 401, message: "Invalid token for this repository" };
  return { ok: true, permission };
}

const GITHUB_CACHE_TTL_MS = 60_000;
const GITHUB_CACHE_MAX = 1_000;
const githubCache = new Map<string, { permission: Permission; expires: number }>();

export function clearGithubCache(): void {
  githubCache.clear();
}

async function authorizeGithub(repo: Repo, token: string, fetcher: Fetcher): Promise<AuthResult> {
  const key = `${toHex(await sha256(token))}:${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
  const cached = githubCache.get(key);
  if (cached && cached.expires > Date.now()) return { ok: true, permission: cached.permission };

  const res = await fetcher(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "r2-lfs",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (res.status === 401) {
    return { ok: false, status: 401, message: "GitHub rejected the token" };
  }
  if (res.status === 403 || res.status === 404) {
    // GitHub hides private repositories the token cannot see behind 404.
    return { ok: false, status: 404, message: "Repository not found or not accessible with this token" };
  }
  if (!res.ok) {
    return { ok: false, status: 502, message: `GitHub API returned ${res.status}` };
  }
  const body = (await res.json()) as { permissions?: { push?: boolean; pull?: boolean } };
  const permission: Permission = body.permissions?.push
    ? "write"
    : body.permissions?.pull
      ? "read"
      : "none";

  if (githubCache.size >= GITHUB_CACHE_MAX) githubCache.clear();
  githubCache.set(key, { permission, expires: Date.now() + GITHUB_CACHE_TTL_MS });
  return { ok: true, permission };
}

export async function authorize(
  config: Config,
  request: Request,
  repo: Repo,
  fetcher: Fetcher,
): Promise<AuthResult> {
  const token = extractToken(request.headers.get("Authorization"));
  if (!token) return { ok: false, status: 401, message: "Credentials required" };
  return config.authMode === "token"
    ? authorizeToken(config, repo, token)
    : authorizeGithub(repo, token, fetcher);
}
