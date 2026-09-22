import { type GrantedPermission, repoPatternMatches } from "../shared/contract.ts";
import type { Config } from "./config.ts";
import type { Repo } from "./repo.ts";

/** `admin` adds unlocking other people's file locks to `write`. */
export type Permission = "none" | GrantedPermission;

const RANK: Record<Permission, number> = { none: 0, read: 1, write: 2, admin: 3 };

export function hasPermission(actual: Permission, required: Permission): boolean {
  return RANK[actual] >= RANK[required];
}

export function repoAllowed(config: Config, repo: Repo): boolean {
  return config.allowedRepos.some((pattern) => repoPatternMatches(pattern, repo.owner, repo.name));
}

export interface Grant {
  scope: string;
  permission: GrantedPermission;
  /** Who the token belongs to, as file locks show it. */
  holder: string;
}

/** The grant with the strongest permission among those that cover the repository, or undefined if none do. */
export function strongestGrant(grants: readonly Grant[], repo: Repo): Grant | undefined {
  let best: Grant | undefined;
  for (const grant of grants) {
    if (!repoPatternMatches(grant.scope, repo.owner, repo.name)) continue;
    if (best === undefined || RANK[grant.permission] > RANK[best.permission]) best = grant;
  }
  return best;
}

/** GitLab access levels: 20 Reporter, 30 Developer, 40 Maintainer, 50 Owner. Public projects are readable. */
export function permissionFromGitlab(
  project:
    | {
        visibility?: string;
        permissions?: { project_access?: { access_level?: number } | null; group_access?: { access_level?: number } | null };
      }
    | undefined,
): Permission {
  const level = Math.max(project?.permissions?.project_access?.access_level ?? 0, project?.permissions?.group_access?.access_level ?? 0);
  if (level >= 40) return "admin";
  if (level >= 30) return "write";
  if (level >= 20 || project?.visibility === "public" || project?.visibility === "internal") return "read";
  return "none";
}

/** Bitbucket Cloud reports `admin`, `write` or `read` for the account. */
export function permissionFromBitbucket(permission: string | undefined): Permission {
  return permission === "admin" || permission === "write" || permission === "read" ? permission : "none";
}

/** GitHub's `permissions` object on a repository describes the authenticated account's role. */
export function permissionFromGithub(
  permissions: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean } | undefined,
): Permission {
  if (permissions?.admin || permissions?.maintain) return "admin";
  if (permissions?.push) return "write";
  if (permissions?.pull) return "read";
  return "none";
}
