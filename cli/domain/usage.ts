import type { History } from "./history.ts";
import { oidOfKey, type StoredObject, totalSize } from "./objects.ts";

const GIB = 1024 ** 3;
// https://developers.cloudflare.com/r2/pricing/ — the 10 GB free tier is per account, so it is not subtracted here.
export const STANDARD_USD_PER_GB_MONTH = 0.015;
export const INFREQUENT_ACCESS_USD_PER_GB_MONTH = 0.01;

export interface FileUsage {
  path: string;
  versions: number;
  /** Sum of every version's size. */
  totalBytes: number;
  latestBytes: number;
  /** Versions the server does not have; 0 when presence is unknown. */
  missing: number;
}

export interface BucketUsage {
  storedBytes: number;
  infrequentAccessBytes: number;
  /** Stored objects that no commit in history references. */
  orphanedBytes: number;
  trashBytes: number;
  monthlyUsd: number;
}

export function monthlyCost(standardBytes: number, infrequentAccessBytes: number): number {
  return (standardBytes / GIB) * STANDARD_USD_PER_GB_MONTH + (infrequentAccessBytes / GIB) * INFREQUENT_ACCESS_USD_PER_GB_MONTH;
}

export function fileUsage(history: History, presence?: ReadonlyMap<string, "stored" | "missing">): FileUsage[] {
  const files = [...history.versions].map(([path, versions]) => ({
    path,
    versions: versions.length,
    totalBytes: totalSize(versions),
    latestBytes: versions[0]?.size ?? 0,
    missing: presence ? versions.filter((v) => presence.get(v.oid) === "missing").length : 0,
  }));
  return files.toSorted((a, b) => b.totalBytes - a.totalBytes || a.path.localeCompare(b.path));
}

export function bucketUsage(history: History, live: readonly StoredObject[], trash: readonly StoredObject[]): BucketUsage {
  const infrequentAccessBytes = totalSize(live.filter((o) => o.storageClass === "STANDARD_IA"));
  const storedBytes = totalSize(live);
  const trashBytes = totalSize(trash);
  return {
    storedBytes,
    infrequentAccessBytes,
    orphanedBytes: totalSize(live.filter((o) => !history.sizes.has(oidOfKey(o.key) ?? ""))),
    trashBytes,
    monthlyUsd: monthlyCost(storedBytes - infrequentAccessBytes + trashBytes, infrequentAccessBytes),
  };
}
