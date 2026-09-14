import { repoAllowed, strongestGrant } from "../domain/access.ts";
import type { Config } from "../domain/config.ts";
import { isSafeRepoName, type Repo } from "../domain/repo.ts";
import { repositoryIdKey, SESSION_TOKEN_PREFIX } from "../shared/contract.ts";
import type {
  ActionsTokenVerifier,
  Authorization,
  Credentials,
  HostPermissions,
  RepositoryIdentities,
  SessionTokens,
  TokenDirectory,
} from "./ports.ts";

export interface AuthorizeDeps {
  tokens: TokenDirectory;
  host: HostPermissions;
  actions: ActionsTokenVerifier;
  identities: RepositoryIdentities;
  sessions: SessionTokens;
  /** Whether the credential has the shape of a JWT, which GitHub and r2-lfs tokens never have. */
  isJwt: (token: string) => boolean;
}

const REUSED_NAME = (repo: Repo) =>
  `${repo.owner}/${repo.name} is a different repository from the one whose LFS objects this server keeps under that name: ` +
  "the name was reused after the original was deleted, renamed or transferred. If that was you, ask the server's " +
  `administrator to delete ${repositoryIdKey(repo.owner, repo.name)} from the bucket.`;

/** Decides what the request may do with the repository: owner allowed, then credentials. */
export async function authorize(
  config: Config,
  repo: Repo,
  credentials: Credentials | undefined,
  deps: AuthorizeDeps,
): Promise<Authorization> {
  if (!isSafeRepoName(repo.name)) return { ok: false, status: 404, message: "Not found" };
  // Before credentials, so the GitHub API is not asked about repositories this server does not serve.
  if (!repoAllowed(config, repo)) return { ok: false, status: 403, message: `${repo.owner}/${repo.name} is not allowed on this server` };
  if (!credentials) return { ok: false, status: 401, message: "Credentials required" };
  const token = credentials.password;
  if (token.startsWith(SESSION_TOKEN_PREFIX)) {
    const claims = await deps.sessions.verify(token);
    // 401 makes git-lfs drop the credential and ask its helper again, which trades for a fresh token.
    if (!claims) return { ok: false, status: 401, message: "The r2-lfs token is invalid or has expired" };
    if (claims.repo !== `${repo.owner}/${repo.name}`.toLowerCase()) {
      return { ok: false, status: 404, message: `This token was issued for ${claims.repo}` };
    }
    return { ok: true, permission: claims.permission, identify: async () => claims.login, ...(claims.oid ? { oid: claims.oid } : {}) };
  }
  if (config.actionsOidc && deps.isJwt(token)) {
    const claims = await deps.actions.verify(token, config.actionsOidc.audience);
    if (!claims)
      return {
        ok: false,
        status: 401,
        message: `Invalid GitHub Actions token; request it for the audience ${config.actionsOidc.audience}`,
      };
    // A workflow reaches only its own repository.
    if (claims.repository.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) {
      return { ok: false, status: 404, message: `A GitHub Actions token from ${claims.repository} cannot use this repository` };
    }
    if (claims.repositoryId !== undefined && !(await deps.identities.claim(repo, claims.repositoryId))) {
      return { ok: false, status: 403, message: REUSED_NAME(repo) };
    }
    return { ok: true, permission: config.actionsOidc.permission, identify: async () => `${claims.actor} (GitHub Actions)` };
  }
  if (config.authMode !== "token") {
    const lookup = await deps.host.lookup(repo, credentials);
    if (!lookup.ok) return lookup;
    // Only an account that can see the repository gets this far, so a name is never claimed for a guess.
    if (lookup.repositoryId !== undefined && !(await deps.identities.claim(repo, lookup.repositoryId))) {
      return { ok: false, status: 403, message: REUSED_NAME(repo) };
    }
    return { ok: true, permission: lookup.permission, identify: () => deps.host.login(credentials) };
  }

  const grants = await deps.tokens.grantsFor(token);
  if (grants.length === 0) return { ok: false, status: 401, message: "Invalid token" };
  const grant = strongestGrant(grants, repo);
  // Not 401: git-lfs would erase the stored credential, which other repositories on this host still accept.
  if (grant === undefined) return { ok: false, status: 404, message: "Repository not found for this token" };
  return { ok: true, permission: grant.permission, identify: async () => grant.holder };
}
