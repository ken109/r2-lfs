import { type LfsLock, OWNER_NAME, REPO_NAME } from "../shared/contract.ts";
import type { Result } from "./lfs.ts";
import type { LockStore } from "./ports.ts";

const REPOSITORY = new RegExp(`^(${OWNER_NAME})/(${REPO_NAME})$`);

/** `owner/repo` as typed into the admin UI. */
export function parseRepository(value: unknown): { owner: string; name: string } | undefined {
  const match = typeof value === "string" ? REPOSITORY.exec(value.trim().replace(/\.git$/, "")) : null;
  return match && !/^\.+$/.test(match[2]!) ? { owner: match[1]!, name: match[2]! } : undefined;
}

export async function repositoryLocks(locks: LockStore, cursor?: string): Promise<{ locks: LfsLock[]; nextCursor?: string }> {
  return locks.list({ limit: 100, ...(cursor ? { cursor } : {}) });
}

/** Removes someone's lock, as `git lfs unlock --force` would with admin permission. */
export async function forceUnlock(locks: LockStore, id: unknown): Promise<Result<LfsLock>> {
  if (typeof id !== "string" || !id) return { ok: false, status: 422, message: "id is required" };
  const lock = await locks.find(id);
  if (!lock) return { ok: false, status: 404, message: "The lock no longer exists" };
  await locks.remove(id);
  return { ok: true, value: lock };
}
