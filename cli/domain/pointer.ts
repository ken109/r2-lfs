export interface Pointer {
  oid: string;
  size: number;
}

/** Pointer files are about 130 bytes; anything larger cannot be one. */
export const MAX_POINTER_SIZE = 1024;

/** Version lines git-lfs accepts: the public spec and the aliases from before its launch. */
const VERSIONS = new Set(["https://git-lfs.github.com/spec/v1", "https://hawser.github.com/spec/v1", "http://git-media.io/v/2"]);

/** Returns the oid and size if `content` is a Git LFS pointer file. Like git-lfs, accepts CRLF line endings. */
export function parsePointer(content: string): Pointer | undefined {
  const text = content.replace(/\r\n/g, "\n");
  const firstLine = text.slice(0, text.indexOf("\n"));
  if (!firstLine.startsWith("version ") || !VERSIONS.has(firstLine.slice("version ".length))) return undefined;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  if (!oid || size === undefined) return undefined;
  return { oid, size: Number(size) };
}
