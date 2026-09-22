import { repoAllowed } from "../domain/access.ts";
import type { Config } from "../domain/config.ts";
import type { Repo } from "../domain/repo.ts";
import { type LfsLock, OWNER_NAME, REPO_NAME } from "../shared/contract.ts";
import type { Result } from "./lfs.ts";
import type { LockStore } from "./ports.ts";

const REPOSITORY = new RegExp(`^(${OWNER_NAME})/(${REPO_NAME})$`);

/** `owner/repo` as typed into the admin UI. */
export function parseRepository(value: unknown): { owner: string; name: string } | undefined {
  const match = typeof value === "string" ? REPOSITORY.exec(value.trim().replace(/\.git$/, "")) : null;
  return match && !/^\.+$/.test(match[2]!) ? { owner: match[1]!, name: match[2]! } : undefined;
}

/**
 * A repository this server serves, as typed into the admin UI. Locks of any other name would only create empty
 * lock objects, so it is refused.
 */
export function servedRepository(config: Config, value: unknown): Result<Repo> {
  const repo = parseRepository(value);
  if (!repo) return { ok: false, status: 422, message: "Enter a repository as owner/name" };
  if (!repoAllowed(config, repo)) {
    return { ok: false, status: 422, message: `${repo.owner}/${repo.name} is not in ALLOWED_REPOS (${config.allowedRepos.join(", ")})` };
  }
  return { ok: true, value: repo };
}

/** A page of locks in lock order, of one path when `path` is given. */
export async function repositoryLocks(
  locks: LockStore,
  cursor?: string,
  path?: string,
): Promise<{ locks: LfsLock[]; nextCursor?: string }> {
  return locks.list({ limit: 100, ...(cursor ? { cursor } : {}), ...(path ? { path } : {}) });
}

/** Removes someone's lock, as `git lfs unlock --force` would with admin permission. */
export async function forceUnlock(locks: LockStore, id: unknown): Promise<Result<LfsLock>> {
  if (typeof id !== "string" || !id) return { ok: false, status: 422, message: "id is required" };
  const lock = await locks.find(id);
  if (!lock) return { ok: false, status: 404, message: "The lock no longer exists" };
  await locks.remove(id);
  return { ok: true, value: lock };
}
