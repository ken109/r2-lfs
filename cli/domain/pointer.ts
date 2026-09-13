export interface Pointer {
  oid: string;
  size: number;
}

/** Pointer files are about 130 bytes; anything larger cannot be one. */
export const MAX_POINTER_SIZE = 1024;

/** Returns the oid and size if `content` is a Git LFS pointer file. */
export function parsePointer(content: string): Pointer | undefined {
  if (!content.startsWith("version https://git-lfs.github.com/spec/v1\n")) return undefined;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(content)?.[1];
  const size = /^size (\d+)$/m.exec(content)?.[1];
  if (!oid || size === undefined) return undefined;
  return { oid, size: Number(size) };
}
