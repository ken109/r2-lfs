import { permissionFromGrants, repoAllowed } from "../domain/access.ts";
import type { Config } from "../domain/config.ts";
import { isSafeRepoName, type Repo } from "../domain/repo.ts";
import type { GithubPermissions, Lookup, TokenDirectory } from "./ports.ts";

export interface AuthorizeDeps {
  tokens: TokenDirectory;
  github: GithubPermissions;
}

/** Decides what the request may do with the repository: owner allowed, then credentials. */
export async function authorize(config: Config, repo: Repo, token: string | undefined, deps: AuthorizeDeps): Promise<Lookup> {
  if (!isSafeRepoName(repo.name)) return { ok: false, status: 404, message: "Not found" };
  // Before credentials, so the GitHub API is not asked about repositories this server does not serve.
  if (!repoAllowed(config, repo)) return { ok: false, status: 403, message: `${repo.owner}/${repo.name} is not allowed on this server` };
  if (!token) return { ok: false, status: 401, message: "Credentials required" };
  if (config.authMode === "github") return deps.github.lookup(repo, token);

  const grants = await deps.tokens.grantsFor(token);
  if (grants.length === 0) return { ok: false, status: 401, message: "Invalid token" };
  const permission = permissionFromGrants(grants, repo);
  // Not 401: git-lfs would erase the stored credential, which other repositories on this host still accept.
  if (permission === undefined) return { ok: false, status: 404, message: "Repository not found for this token" };
  return { ok: true, permission };
}
