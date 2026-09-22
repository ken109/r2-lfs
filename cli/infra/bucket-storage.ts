import { TRASH_PREFIX } from "../../src/shared/contract.ts";
import { moveToTrash, restoreFromTrash, type TrashStep, type TrashStore } from "../../src/shared/trash.ts";
import type { Bucket, ObjectStorage, Outcome, RestoredObject, WriteResult } from "../app/ports.ts";
import type { StoredObject } from "../domain/objects.ts";

const step = (result: WriteResult): TrashStep =>
  result.ok ? { ok: true } : { ok: false, refusal: result.locked ? "locked" : "failed", detail: `${result.status} ${result.message}` };

/** The bucket as the trash procedures see it; refusals read as the S3 API's status and message. */
function trashStore(bucket: Bucket): TrashStore {
  return {
    copy: async (source, target) => step(await bucket.copy(source, target)),
    delete: async (key) => step(await bucket.delete(key)),
    exists: (key) => bucket.exists(key),
  };
}

/** Copies to the trash before deleting, so a refused delete never loses data. */
export async function trashObject(bucket: Bucket, object: StoredObject): Promise<Outcome> {
  const key = object.key;
  const result = await moveToTrash(trashStore(bucket), key, `${TRASH_PREFIX}${key}`);
  switch (result.outcome) {
    case "trashed":
    case "locked":
      return { key, action: result.outcome, ok: true };
    case "copy-refused":
      return { key, action: "trash", ok: false, message: `copy failed: ${result.detail}` };
    case "delete-refused": {
      const refused = `delete refused: ${result.detail}`;
      const message = result.checked ? refused : `${refused}; kept the trash copy because the object could not be checked`;
      return { key, action: "trash", ok: false, message };
    }
  }
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
      const result = await restoreFromTrash(trashStore(this.bucket), key, key.slice(TRASH_PREFIX.length));
      if (result.outcome === "copy-refused") return { key, ok: false, message: `copy failed: ${result.detail}` };
      // The object is back either way; a leftover trash copy expires with the lifecycle rule.
      return result.copyRemoved
        ? { key, ok: true }
        : { key, ok: true, message: "restored, but the trash copy could not be removed and will expire" };
    });
  }
}
