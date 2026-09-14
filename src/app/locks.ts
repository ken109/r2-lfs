import { hasPermission, type Permission } from "../domain/access.ts";
import type { LfsLock } from "../shared/contract.ts";
import type { LockStore } from "./ports.ts";

export interface LocksContext {
  permission: Permission;
  identify: () => Promise<string | undefined>;
  locks: LockStore;
}

/** A response of the locking API: its status and JSON body. */
export type LockResponse = { status: number; body: unknown };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const message = (status: number, text: string): LockResponse => ({ status, body: { message: text } });

function limitOf(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : undefined;
}

async function holder(ctx: LocksContext): Promise<string | LockResponse> {
  if (!hasPermission(ctx.permission, "write")) return message(403, "You need write access to lock files");
  return (await ctx.identify()) ?? message(403, "Could not tell who you are; locks need a named holder");
}

/** POST /locks */
export async function createLock(ctx: LocksContext, body: unknown): Promise<LockResponse> {
  const owner = await holder(ctx);
  if (typeof owner !== "string") return owner;
  const path = (body as { path?: unknown } | null)?.path;
  if (typeof path !== "string" || path.trim() === "") return message(422, "path is required");
  const { created, lock } = await ctx.locks.create(path, owner);
  return created
    ? { status: 201, body: { lock } }
    : { status: 409, body: { lock, message: `${path} is already locked by ${lock.owner.name}` } };
}

/** GET /locks */
export async function listLocks(ctx: LocksContext, query: URLSearchParams): Promise<LockResponse> {
  if (!hasPermission(ctx.permission, "read")) return message(403, "You need read access to list locks");
  const limit = limitOf(query.get("limit"));
  if (limit === undefined) return message(422, "limit must be a positive integer");
  const page = await ctx.locks.list({
    limit,
    ...(query.get("path") ? { path: query.get("path")! } : {}),
    ...(query.get("id") ? { id: query.get("id")! } : {}),
    ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}),
  });
  return { status: 200, body: { locks: page.locks, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) } };
}

/** POST /locks/verify: the caller's locks and everyone else's, for git-lfs to check before a push. */
export async function verifyLocks(ctx: LocksContext, body: unknown): Promise<LockResponse> {
  const owner = await holder(ctx);
  if (typeof owner !== "string") return owner;
  const { cursor, limit: rawLimit } = (body ?? {}) as { cursor?: unknown; limit?: unknown };
  const limit = limitOf(rawLimit);
  if (limit === undefined) return message(422, "limit must be a positive integer");
  const page = await ctx.locks.list({ limit, ...(typeof cursor === "string" && cursor ? { cursor } : {}) });
  const ours: LfsLock[] = [];
  const theirs: LfsLock[] = [];
  for (const lock of page.locks) (lock.owner.name === owner ? ours : theirs).push(lock);
  return { status: 200, body: { ours, theirs, ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}) } };
}

/** POST /locks/:id/unlock. Only admins may force-unlock someone else's lock. */
export async function unlock(ctx: LocksContext, id: string, body: unknown): Promise<LockResponse> {
  const owner = await holder(ctx);
  if (typeof owner !== "string") return owner;
  const lock = await ctx.locks.find(id);
  if (!lock) return message(404, "Lock not found");
  if (lock.owner.name !== owner) {
    if ((body as { force?: unknown } | null)?.force !== true) return message(403, `${lock.path} is locked by ${lock.owner.name}`);
    if (!hasPermission(ctx.permission, "admin")) return message(403, "Only admins can unlock files locked by someone else");
  }
  await ctx.locks.remove(id);
  return { status: 200, body: { lock } };
}
