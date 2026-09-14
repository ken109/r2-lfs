import { TRASH_PREFIX } from "../../src/shared/contract.ts";
import type { Bucket, ObjectStorage, Outcome, RestoredObject } from "../app/ports.ts";
import type { StoredObject } from "../domain/objects.ts";

/** Copies to the trash before deleting, so a refused delete never loses data. */
export async function trashObject(bucket: Bucket, object: StoredObject): Promise<Outcome> {
  const key = object.key;
  const target = `${TRASH_PREFIX}${key}`;
  const copied = await bucket.copy(key, target);
  if (!copied.ok) return { key, action: "trash", ok: false, message: `copy failed: ${copied.status} ${copied.message}` };
  const deleted = await bucket.delete(key);
  if (deleted.ok) return { key, action: "trashed", ok: true };
  if (deleted.locked) {
    await bucket.delete(target);
    return { key, action: "locked", ok: true };
  }

  // An error response does not prove nothing was deleted, as with a timeout, so drop the copy only when the object is still there.
  const refused = `delete refused: ${deleted.status} ${deleted.message}`;
  let stillThere: boolean;
  try {
    stillThere = await bucket.exists(key);
  } catch {
    return { key, action: "trash", ok: false, message: `${refused}; kept the trash copy because the object could not be checked` };
  }
  if (!stillThere) return { key, action: "trashed", ok: true };
  await bucket.delete(target);
  return { key, action: "trash", ok: false, message: refused };
}

async function each<T>(objects: readonly StoredObject[], progress: (done: number) => void, act: (o: StoredObject) => Promise<T>) {
  const results: T[] = [];
  for (const object of objects) {
    results.push(await act(object));
    progress(1);
  }
  return results;
}

/** The bucket through R2's S3 API, with credentials that reach every repository's objects. */
export class BucketStorage implements ObjectStorage {
  readonly throughServer = false;
  private readonly bucket: Bucket;

  constructor(bucket: Bucket) {
    this.bucket = bucket;
  }

  get name(): string {
    return this.bucket.name;
  }

  get encrypted(): boolean {
    return this.bucket.encrypted;
  }

  list(prefix: string): Promise<StoredObject[]> {
    return this.bucket.list(prefix);
  }

  trash(objects: readonly StoredObject[], progress: (done: number) => void): Promise<Outcome[]> {
    return each(objects, progress, (object) => trashObject(this.bucket, object));
  }

  delete(objects: readonly StoredObject[], progress: (done: number) => void): Promise<Outcome[]> {
    return each(objects, progress, async ({ key }): Promise<Outcome> => {
      const result = await this.bucket.delete(key);
      if (result.ok) return { key, action: "deleted", ok: true };
      if (result.locked) return { key, action: "locked", ok: true };
      return { key, action: "delete", ok: false, message: `${result.status} ${result.message}` };
    });
  }

  tier(objects: readonly StoredObject[], progress: (done: number) => void): Promise<Outcome[]> {
    return each(objects, progress, async ({ key }): Promise<Outcome> => {
      const result = await this.bucket.copy(key, key, "STANDARD_IA");
      if (result.ok) return { key, action: "tiered", ok: true };
      if (result.locked) return { key, action: "locked", ok: true };
      return { key, action: "tier", ok: false, message: `${result.status} ${result.message}` };
    });
  }

  restore(objects: readonly StoredObject[], progress: (done: number) => void): Promise<RestoredObject[]> {
    return each(objects, progress, async ({ key }): Promise<RestoredObject> => {
      const copied = await this.bucket.copy(key, key.slice(TRASH_PREFIX.length));
      if (!copied.ok) return { key, ok: false, message: `copy failed: ${copied.status} ${copied.message}` };
      const removed = await this.bucket.delete(key);
      // The object is back either way; a leftover trash copy expires with the lifecycle rule.
      return removed.ok
        ? { key, ok: true }
        : { key, ok: true, message: "restored, but the trash copy could not be removed and will expire" };
    });
  }
}
