import type { Config } from "../domain/config.ts";
import type { StorageAction, StorageChanges, StorageListing } from "../shared/contract.ts";
import { parseRepository } from "./admin-locks.ts";
import type { Result } from "./lfs.ts";
import type { RepositoryStorage } from "./ports.ts";
import { changeObjects, listObjects, type StorageContext } from "./repository-storage.ts";

export interface ObjectsDeps {
  config: Config;
  storage: RepositoryStorage;
}

const notARepository: Result<never> = { ok: false, status: 422, message: "Enter a repository as owner/name" };

/**
 * The admin UI acts as a repository administrator of any repository whose objects are in the bucket, including one
 * no longer in ALLOWED_REPOS: cleaning up after a repository is exactly what it is for.
 */
function context(deps: ObjectsDeps, repository: unknown): Result<StorageContext & { name: string }> {
  const repo = parseRepository(repository);
  if (!repo) return notARepository;
  return {
    ok: true,
    value: { config: deps.config, repo, permission: "admin", storage: deps.storage, name: `${repo.owner}/${repo.name}`.toLowerCase() },
  };
}

/** One page of a repository's live or trashed objects. */
export async function repositoryObjects(
  deps: ObjectsDeps,
  repository: unknown,
  where: unknown,
  cursor: unknown,
): Promise<Result<StorageListing & { repository: string }>> {
  const ctx = context(deps, repository);
  if (!ctx.ok) return ctx;
  const listed = await listObjects(
    ctx.value,
    typeof where === "string" ? where : null,
    typeof cursor === "string" && cursor ? cursor : null,
  );
  return listed.ok ? { ok: true, value: { repository: ctx.value.name, ...listed.value } } : listed;
}

const ACTIONS = new Set<unknown>(["trash", "restore", "tier"] satisfies StorageAction[]);

/** Trashes, restores or tiers up to MAX_STORAGE_CHANGES objects; the UI splits larger selections. */
export async function changeRepositoryObjects(
  deps: ObjectsDeps,
  repository: unknown,
  action: unknown,
  oids: unknown,
): Promise<Result<StorageChanges>> {
  const ctx = context(deps, repository);
  if (!ctx.ok) return ctx;
  if (!ACTIONS.has(action)) return { ok: false, status: 422, message: "action must be trash, restore or tier" };
  return changeObjects(ctx.value, action as StorageAction, { oids });
}
