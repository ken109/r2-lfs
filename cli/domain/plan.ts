import { oidOfKey, type StoredObject } from "./objects.ts";
import { effectiveFor, type Policy } from "./policy.ts";

/** What the git history says about LFS objects. */
export interface Facts {
  /** Every path each object has appeared at, anywhere in history. */
  paths: Map<string, Set<string>>;
  /** Objects in the tree of any branch, remote-tracking branch or tag tip. */
  tips: Set<string>;
  /** Objects in trees of commits newer than N days, keyed by N. */
  windows: Map<number, Set<string>>;
  /** Versions of each path, newest first. */
  versions: Map<string, string[]>;
}

export type Decision = { kind: "keep"; reason: string } | { kind: "young" } | { kind: "delete" } | { kind: "tier" } | { kind: "foreign" };

export interface Planned {
  object: StoredObject;
  oid: string | undefined;
  paths: string[];
  decision: Decision;
}

function keepReason(oid: string, paths: string[], facts: Facts, policy: Policy): string | undefined {
  if (facts.tips.has(oid)) return "in a branch or tag tip";
  // An object that history does not know is judged by the defaults.
  const candidates = paths.length > 0 ? paths : [undefined];
  for (const path of candidates) {
    const eff = effectiveFor(policy, path);
    const label = path ?? "unknown path";
    if (eff.keepAll) return `${label}: rule "${eff.rule}" keeps all versions`;
    if (facts.windows.get(eff.keepDays)?.has(oid)) return `${label}: used in the last ${eff.keepDays} days`;
    if (path !== undefined && eff.keepVersions > 0) {
      const newest = facts.versions.get(path)?.slice(0, eff.keepVersions) ?? [];
      if (newest.includes(oid)) return `${label}: one of the newest ${eff.keepVersions} versions`;
    }
  }
  return undefined;
}

export function planObjects(stored: readonly StoredObject[], facts: Facts, policy: Policy, now: Date): Planned[] {
  const cutoff = now.getTime() - policy.minAgeDays * 86_400_000;
  return stored.map((object) => {
    const oid = oidOfKey(object.key);
    if (!oid) return { object, oid, paths: [], decision: { kind: "foreign" } };
    const paths = [...(facts.paths.get(oid) ?? [])].toSorted();

    const reason = keepReason(oid, paths, facts, policy);
    if (reason) return { object, oid, paths, decision: { kind: "keep", reason } };
    if (object.lastModified.getTime() > cutoff) return { object, oid, paths, decision: { kind: "young" } };

    // When paths disagree, the gentler action wins.
    const tier = (paths.length > 0 ? paths : [undefined]).some((path) => effectiveFor(policy, path).oldVersions === "infrequent-access");
    if (tier) {
      return object.storageClass === "STANDARD_IA"
        ? { object, oid, paths, decision: { kind: "keep", reason: "already in Infrequent Access" } }
        : { object, oid, paths, decision: { kind: "tier" } };
    }
    return { object, oid, paths, decision: { kind: "delete" } };
  });
}

export function mergeFacts(into: Facts, other: Facts): void {
  for (const [oid, paths] of other.paths) {
    const set = into.paths.get(oid) ?? new Set<string>();
    for (const p of paths) set.add(p);
    into.paths.set(oid, set);
  }
  for (const oid of other.tips) into.tips.add(oid);
  for (const [days, oids] of other.windows) {
    const set = into.windows.get(days) ?? new Set<string>();
    for (const oid of oids) set.add(oid);
    into.windows.set(days, set);
  }
  for (const [path, oids] of other.versions) {
    into.versions.set(path, [...new Set([...(into.versions.get(path) ?? []), ...oids])]);
  }
}
