import { UsageError } from "../domain/errors.ts";
import { oidOfKey, type StoredObject } from "../domain/objects.ts";
import { readHistory, requireKeyIfEncrypted, requireSupport, resolveLayout } from "./common.ts";
import type { GitRepository, LfsClient, ObjectStorage, Reporter } from "./ports.ts";

export interface RestoreDeps {
  repo: GitRepository;
  client: LfsClient;
  storage: ObjectStorage;
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
  const { repo, client, storage, reporter } = deps;
  const resolved = await resolveLayout(client, layout);
  if (resolved === "shared") requireSupport(storage, "sharedLayout", "restore");
  const trash = await reporter.task(
    "Listing the trash",
    () => storage.list("trash", resolved),
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

export async function restoreObjects(
  deps: { storage: ObjectStorage; reporter: Reporter; client?: LfsClient },
  selected: TrashedObject[],
): Promise<RestoreOutcome[]> {
  if (deps.client) await requireKeyIfEncrypted(deps.client, deps.storage);
  const bar = deps.reporter.progress(selected.length, "Restoring");
  const restored = await deps.storage.restore(
    selected.map((t) => t.object),
    (done) => bar.advance(done),
  );
  bar.stop(`Processed ${selected.length} objects`);
  const byKey = new Map(restored.map((r) => [r.key, r]));
  return selected.map(({ object, oid }) => {
    const { ok, message } = byKey.get(object.key) ?? { ok: false, message: "no answer for this object" };
    return { oid, ok, ...(message ? { message } : {}) };
  });
}
