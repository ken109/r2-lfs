// Moving objects into and out of the trash safely, for gc and restore in both the Worker and the CLI. R2 has no object
// versioning, so every step that could lose the only copy is checked here, once.

/** How one copy or delete went. `detail` describes a refusal for messages, such as `404 NoSuchKey`. */
export type TrashStep = { ok: true } | { ok: false; refusal: "missing" | "locked" | "failed"; detail: string };

/** What the trash procedures need from a bucket. */
export interface TrashStore {
  copy(source: string, target: string): Promise<TrashStep>;
  /** May throw when the answer is lost; that proves nothing about whether the object is gone. */
  delete(key: string): Promise<TrashStep>;
  /** Throws when the bucket cannot say. */
  exists(key: string): Promise<boolean>;
}

export type TrashResult =
  | { outcome: "trashed" }
  /** A bucket lock rule still protects the object; its trash copy was dropped. */
  | { outcome: "locked" }
  | { outcome: "copy-refused"; refusal: "missing" | "locked" | "failed"; detail: string }
  /** `checked` is false when the object could not be checked afterwards, so the trash copy was kept. */
  | { outcome: "delete-refused"; detail: string; checked: boolean };

export type RestoreResult =
  | { outcome: "restored"; copyRemoved: boolean }
  | { outcome: "copy-refused"; refusal: "missing" | "failed"; detail: string };

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function deleteQuietly(store: TrashStore, key: string): Promise<boolean> {
  return (await store.delete(key).catch(() => ({ ok: false }))).ok;
}

/**
 * Copies `key` to `trashKey`, then deletes it. A delete refused by a lock rule drops the copy; any other failed delete
 * drops it only after checking that the object is still in place, since an error response does not prove nothing was
 * deleted, so the object is never left in neither place.
 */
export async function moveToTrash(store: TrashStore, key: string, trashKey: string): Promise<TrashResult> {
  const copied = await store.copy(key, trashKey);
  if (!copied.ok) return { outcome: "copy-refused", refusal: copied.refusal, detail: copied.detail };
  let deleted: TrashStep;
  try {
    deleted = await store.delete(key);
  } catch (err) {
    deleted = { ok: false, refusal: "failed", detail: describe(err) };
  }
  if (deleted.ok) return { outcome: "trashed" };
  if (deleted.refusal === "locked") {
    await deleteQuietly(store, trashKey);
    return { outcome: "locked" };
  }

  let stillThere: boolean;
  try {
    stillThere = await store.exists(key);
  } catch {
    return { outcome: "delete-refused", detail: deleted.detail, checked: false };
  }
  if (!stillThere) return { outcome: "trashed" };
  await deleteQuietly(store, trashKey);
  return { outcome: "delete-refused", detail: deleted.detail, checked: true };
}

/**
 * Copies a trashed object back to `key`, then removes the trash copy. A lock rule refuses to overwrite only an object
 * that is already back in place, so that counts as restored; a leftover trash copy expires with the lifecycle rule.
 */
export async function restoreFromTrash(store: TrashStore, trashKey: string, key: string): Promise<RestoreResult> {
  const copied = await store.copy(trashKey, key);
  if (!copied.ok && copied.refusal !== "locked") return { outcome: "copy-refused", refusal: copied.refusal, detail: copied.detail };
  return { outcome: "restored", copyRemoved: await deleteQuietly(store, trashKey) };
}
