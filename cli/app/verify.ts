import { createHash } from "node:crypto";

import { oidOfKey } from "../domain/objects.ts";
import { presence, readHistory, resolveLayout, trashPrefix } from "./common.ts";
import type { ObjectStorage, GitRepository, LfsClient, Reporter } from "./ports.ts";

export interface VerifyDeps {
  repo: GitRepository;
  client: LfsClient;
  reporter: Reporter;
  /** Optional; lets missing objects be looked up in the trash. */
  storage?: ObjectStorage;
}

export interface VerifyOptions {
  /** Every version in history instead of only ref tips. */
  all: boolean;
  /** Download and hash every stored object. */
  deep: boolean;
  layout?: string;
}

export interface MissingObject {
  oid: string;
  size: number;
  paths: string[];
  inTrash: boolean;
}

export interface VerifyResult {
  checked: number;
  missing: MissingObject[];
  corrupt: string[];
}

export async function verifyObjects(deps: VerifyDeps, opts: VerifyOptions): Promise<VerifyResult> {
  const { repo, client, reporter } = deps;

  const wanted = await reporter.task(
    opts.all ? "Reading every LFS version in history" : "Reading branch and tag tips",
    () => {
      const map = new Map<string, { size: number; paths: Set<string> }>();
      if (opts.all) {
        const history = readHistory(repo);
        for (const [oid, paths] of history.paths) map.set(oid, { size: history.sizes.get(oid) ?? 0, paths: new Set(paths) });
      }
      // Tips are included even with --all: a merge can introduce content no single commit diff shows.
      for (const [oid, at] of repo.pointersIn(repo.refTips())) {
        const entry = map.get(oid) ?? { size: at.size, paths: new Set<string>() };
        for (const path of at.paths) entry.paths.add(path);
        map.set(oid, entry);
      }
      return map;
    },
    (map) => `${map.size} objects to check`,
  );

  const objects = [...wanted].map(([oid, v]) => ({ oid, size: v.size }));
  const state = await reporter.task("Asking the server", () => presence(client, objects));

  const corrupt: string[] = [];
  if (opts.deep) {
    const stored = objects.filter((o) => state.get(o.oid) === "stored");
    const bar = reporter.progress(stored.length, "Downloading and hashing");
    for (const result of await client.batch("download", stored)) {
      const hash = createHash("sha256");
      for await (const chunk of await client.download(result)) hash.update(chunk);
      if (hash.digest("hex") !== result.oid) corrupt.push(result.oid);
      bar.advance(1, result.oid.slice(0, 10));
    }
    bar.stop(`Hashed ${stored.length} objects`);
  }

  const missingRefs = objects.filter((o) => state.get(o.oid) !== "stored");
  const trashed = new Set<string>();
  if (missingRefs.length > 0 && deps.storage) {
    const prefix = trashPrefix(client, await resolveLayout(client, opts.layout));
    for (const object of await deps.storage.list(prefix)) trashed.add(oidOfKey(object.key) ?? "");
  }

  return {
    checked: objects.length,
    missing: missingRefs.map((o) => ({ ...o, paths: [...wanted.get(o.oid)!.paths].toSorted(), inTrash: trashed.has(o.oid) })),
    corrupt,
  };
}
