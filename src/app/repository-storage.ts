import { hasPermission, type Permission } from "../domain/access.ts";
import type { Config } from "../domain/config.ts";
import type { Repo } from "../domain/repo.ts";
import {
  MAX_STORAGE_CHANGES,
  OID_PATTERN,
  repoPrefix,
  type StorageAction,
  type StorageChanges,
  type StorageListing,
  TRASH_PREFIX,
} from "../shared/contract.ts";
import { moveToTrash, restoreFromTrash, type TrashStore } from "../shared/trash.ts";
import type { Result } from "./lfs.ts";
import type { RepositoryStorage } from "./ports.ts";

export interface StorageContext {
  config: Config;
  repo: Repo;
  permission: Permission;
  storage: RepositoryStorage;
}

const reject = (status: number, message: string): Result<never> => ({ ok: false, status, message });

/** Moving objects to the trash and to Infrequent Access is repository administration; restoring only adds objects back. */
const REQUIRED: Record<StorageAction, Permission> = { trash: "admin", tier: "admin", restore: "write" };

function prefixes(ctx: StorageContext): Result<{ live: string; trash: string }> {
  // In the shared layout one object serves several repositories, which a single repository cannot judge.
  if (ctx.config.storageLayout !== "per-repo") {
    return reject(409, "This server uses the shared layout; gc and restore there need R2 API credentials");
  }
  const live = repoPrefix("per-repo", ctx.repo.owner, ctx.repo.name);
  return { ok: true, value: { live, trash: `${TRASH_PREFIX}${live}` } };
}

export async function listObjects(ctx: StorageContext, where: string | null, cursor: string | null): Promise<Result<StorageListing>> {
  if (!hasPermission(ctx.permission, "read")) return reject(403, "You do not have read access to this repository");
  if (where !== "live" && where !== "trash") return reject(422, 'in must be "live" or "trash"');
  const located = prefixes(ctx);
  if (!located.ok) return located;
  const prefix = located.value[where];
  const page = await ctx.storage.list(prefix, cursor ?? undefined);
  const objects = page.objects.flatMap((o) => {
    const oid = o.key.slice(prefix.length);
    if (!OID_PATTERN.test(oid)) return [];
    const storageClass = o.storageClass === "InfrequentAccess" ? ("STANDARD_IA" as const) : ("STANDARD" as const);
    return [{ oid, size: o.size, uploaded: o.uploaded.toISOString(), storage_class: storageClass }];
  });
  return { ok: true, value: { objects, ...(page.cursor ? { cursor: page.cursor } : {}) } };
}

function parseOids(body: unknown): Result<string[]> {
  const oids = (body as { oids?: unknown } | null)?.oids;
  if (!Array.isArray(oids) || oids.length === 0 || !oids.every((o): o is string => typeof o === "string" && OID_PATTERN.test(o))) {
    return reject(422, "oids must be a non-empty array of SHA-256 oids");
  }
  if (oids.length > MAX_STORAGE_CHANGES) return reject(422, `At most ${MAX_STORAGE_CHANGES} oids per request`);
  return { ok: true, value: [...new Set(oids)] };
}

type Change = StorageChanges["results"][number];
const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The bucket as the trash procedures see it, copying only content that hashes to `oid`. */
function trashStore(storage: RepositoryStorage, oid: string): TrashStore {
  return {
    async copy(source, target) {
      const copied = await storage.copy(source, target, { sha256: oid });
      if (copied === "copied") return { ok: true };
      return { ok: false, refusal: copied === "checksum-mismatch" ? "failed" : copied, detail: copied };
    },
    async delete(key) {
      return (await storage.delete(key)) === "deleted" ? { ok: true } : { ok: false, refusal: "locked", detail: "locked" };
    },
    exists: async (key) => (await storage.head(key)) !== null,
  };
}

async function trash(storage: RepositoryStorage, oid: string, live: string, trashed: string): Promise<Change> {
  const result = await moveToTrash(trashStore(storage, oid), live, trashed);
  switch (result.outcome) {
    case "trashed":
    case "locked":
      return { oid, outcome: result.outcome };
    case "copy-refused":
      if (result.refusal === "missing") return { oid, outcome: "missing" };
      return { oid, outcome: "failed", message: `copying to the trash: ${result.detail}` };
    case "delete-refused":
      return { oid, outcome: "failed", message: result.detail };
  }
}

async function restore(storage: RepositoryStorage, oid: string, live: string, trashed: string): Promise<Change> {
  const result = await restoreFromTrash(trashStore(storage, oid), trashed, live);
  if (result.outcome === "restored") return { oid, outcome: "restored" };
  if (result.refusal === "missing") return { oid, outcome: "missing" };
  return { oid, outcome: "failed", message: `copying back: ${result.detail}` };
}

async function tier(storage: RepositoryStorage, oid: string, live: string): Promise<Change> {
  const head = await storage.head(live);
  if (!head) return { oid, outcome: "missing" };
  if (head.storageClass === "InfrequentAccess") return { oid, outcome: "tiered" };
  const copied = await storage.copy(live, live, { sha256: oid, storageClass: "InfrequentAccess" });
  if (copied === "copied") return { oid, outcome: "tiered" };
  if (copied === "locked" || copied === "missing") return { oid, outcome: copied };
  return { oid, outcome: "failed", message: copied };
}

export async function changeObjects(ctx: StorageContext, action: StorageAction, body: unknown): Promise<Result<StorageChanges>> {
  const required = REQUIRED[action];
  if (!hasPermission(ctx.permission, required)) return reject(403, `You do not have ${required} access to this repository`);
  const located = prefixes(ctx);
  if (!located.ok) return located;
  const parsed = parseOids(body);
  if (!parsed.ok) return parsed;

  const results: Change[] = [];
  for (const oid of parsed.value) {
    const live = `${located.value.live}${oid}`;
    const trashed = `${located.value.trash}${oid}`;
    try {
      if (action === "trash") results.push(await trash(ctx.storage, oid, live, trashed));
      else if (action === "restore") results.push(await restore(ctx.storage, oid, live, trashed));
      else results.push(await tier(ctx.storage, oid, live));
    } catch (err) {
      results.push({ oid, outcome: "failed", message: describe(err) });
    }
  }
  return { ok: true, value: { results } };
}
