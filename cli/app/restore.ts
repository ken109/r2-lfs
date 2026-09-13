import { TRASH_PREFIX } from "../../src/shared/contract.ts";
import { UsageError } from "../domain/errors.ts";
import { oidOfKey, type StoredObject } from "../domain/objects.ts";
import { readHistory, resolveLayout, trashPrefix } from "./common.ts";
import type { Bucket, GitRepository, LfsClient, Reporter } from "./ports.ts";

export interface RestoreDeps {
  repo: GitRepository;
  client: LfsClient;
  bucket: Bucket;
  reporter: Reporter;
}

export type Selection =
  | { kind: "all" }
  | { kind: "oids"; prefixes: string[] }
  | { kind: "path"; path: string }
  | { kind: "since"; date: Date };

export interface TrashedObject {
  object: StoredObject;
  oid: string;
  paths: string[];
}

export async function listTrash(deps: RestoreDeps, layout?: string): Promise<TrashedObject[]> {
  const { repo, client, bucket, reporter } = deps;
  const prefix = trashPrefix(client, await resolveLayout(client, layout));
  const trash = await reporter.task(
    "Listing the trash",
    () => bucket.list(prefix),
    (t) => `${t.length} objects in the trash`,
  );
  const history = readHistory(repo);
  return trash.flatMap((object) => {
    const oid = oidOfKey(object.key);
    return oid ? [{ object, oid, paths: [...(history.paths.get(oid) ?? [])].toSorted() }] : [];
  });
}

export function selectTrash(trash: TrashedObject[], selection: Selection, versionsOfPath?: (path: string) => string[]): TrashedObject[] {
  switch (selection.kind) {
    case "all":
      return trash;
    case "since":
      return trash.filter((t) => t.object.lastModified >= selection.date);
    case "path": {
      const wanted = new Set(versionsOfPath?.(selection.path) ?? []);
      return trash.filter((t) => wanted.has(t.oid) || t.paths.includes(selection.path));
    }
    case "oids":
      return selection.prefixes.map((prefix) => {
        const matches = trash.filter((t) => t.oid.startsWith(prefix));
        if (matches.length === 0) throw new UsageError(`nothing in the trash starts with ${prefix}`);
        if (matches.length > 1) throw new UsageError(`${prefix} is ambiguous: ${matches.map((m) => m.oid.slice(0, 10)).join(", ")}`);
        return matches[0]!;
      });
  }
}

export interface RestoreOutcome {
  oid: string;
  ok: boolean;
  /** Set when something needs the user's attention. */
  message?: string;
}

export async function restoreObjects(deps: { bucket: Bucket; reporter: Reporter }, selected: TrashedObject[]): Promise<RestoreOutcome[]> {
  const outcomes: RestoreOutcome[] = [];
  const bar = deps.reporter.progress(selected.length, "Restoring");
  for (const { object, oid } of selected) {
    const copied = await deps.bucket.copy(object.key, object.key.slice(TRASH_PREFIX.length));
    if (!copied.ok) outcomes.push({ oid, ok: false, message: `copy failed: ${copied.status} ${copied.message}` });
    else {
      const removed = await deps.bucket.delete(object.key);
      // The object is back either way; a leftover trash copy expires with the lifecycle rule.
      outcomes.push(
        removed.ok ? { oid, ok: true } : { oid, ok: true, message: "restored, but the trash copy could not be removed and will expire" },
      );
    }
    bar.advance(1, oid.slice(0, 10));
  }
  bar.stop(`Processed ${selected.length} objects`);
  return outcomes;
}
