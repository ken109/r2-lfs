import type { Pointer } from "./pointer.ts";

/** One commit adding or changing an LFS pointer at a path. */
export interface PointerChange extends Pointer {
  path: string;
  commit: string;
  /** Committer time, unix seconds. */
  time: number;
}

export interface Version {
  oid: string;
  size: number;
  /** The latest commit time at which this content was written to the path. */
  time: number;
}

export interface History {
  /** Versions of each path, newest first. */
  versions: Map<string, Version[]>;
  /** Every path each object has appeared at. */
  paths: Map<string, Set<string>>;
  sizes: Map<string, number>;
}

export function addPath(paths: Map<string, Set<string>>, oid: string, path: string): void {
  let set = paths.get(oid);
  if (!set) {
    set = new Set();
    paths.set(oid, set);
  }
  set.add(path);
}

export function buildHistory(changes: Iterable<PointerChange>): History {
  const latest = new Map<string, Map<string, Version>>();
  const paths = new Map<string, Set<string>>();
  const sizes = new Map<string, number>();
  for (const change of changes) {
    addPath(paths, change.oid, change.path);
    sizes.set(change.oid, change.size);
    let byOid = latest.get(change.path);
    if (!byOid) {
      byOid = new Map();
      latest.set(change.path, byOid);
    }
    const seen = byOid.get(change.oid);
    if (!seen || seen.time < change.time) byOid.set(change.oid, { oid: change.oid, size: change.size, time: change.time });
  }
  const versions = new Map<string, Version[]>();
  for (const [path, byOid] of latest)
    versions.set(
      path,
      [...byOid.values()].toSorted((a, b) => b.time - a.time),
    );
  return { versions, paths, sizes };
}
