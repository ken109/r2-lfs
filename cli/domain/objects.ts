import { OID_PATTERN } from "../../src/shared/contract.ts";

/** An object as listed from the bucket. */
export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
  storageClass: string;
}

export interface ObjectRef {
  oid: string;
  size: number;
}

/** The oid at the end of a bucket key, or undefined for keys that are not LFS objects. */
export function oidOfKey(key: string): string | undefined {
  const oid = key.slice(key.lastIndexOf("/") + 1);
  return OID_PATTERN.test(oid) ? oid : undefined;
}

export function totalSize(objects: readonly { size: number }[]): number {
  return objects.reduce((sum, o) => sum + o.size, 0);
}
