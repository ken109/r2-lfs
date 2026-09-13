import { scopeCovers } from "../shared/contract.ts";
import type { Config } from "./config.ts";
import type { Repo } from "./repo.ts";

export type Permission = "none" | "read" | "write";

const RANK: Record<Permission, number> = { none: 0, read: 1, write: 2 };

export function hasPermission(actual: Permission, required: Permission): boolean {
  return RANK[actual] >= RANK[required];
}

export function ownerAllowed(config: Config, owner: string): boolean {
  return config.allowedOwners === "*" || config.allowedOwners.has(owner.toLowerCase());
}

export interface Grant {
  scope: string;
  permission: "read" | "write";
}

/** The strongest permission among grants that cover the repository, or undefined if none do. */
export function permissionFromGrants(grants: readonly Grant[], repo: Repo): Permission | undefined {
  let best: Permission | undefined;
  for (const grant of grants) {
    if (!scopeCovers(grant.scope, repo.owner, repo.name)) continue;
    if (best === undefined || RANK[grant.permission] > RANK[best]) best = grant.permission;
  }
  return best;
}

/** GitHub's `permissions` object on a repository describes the authenticated account's role. */
export function permissionFromGithub(permissions: { push?: boolean; pull?: boolean } | undefined): Permission {
  if (permissions?.push) return "write";
  if (permissions?.pull) return "read";
  return "none";
}
