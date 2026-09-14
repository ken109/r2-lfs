/**
 * The single byte range of an HTTP Range header, as git-lfs sends to resume a download. Anything this does not
 * understand, such as several ranges, means the whole object, which HTTP allows.
 */
export function parseRange(header: string | null, size: number): { offset: number; length: number } | "unsatisfiable" | undefined {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match) return undefined;
  const [, start = "", end = ""] = match;
  if (start === "" && end === "") return undefined;
  if (start === "") {
    // A suffix: the last `end` bytes.
    const length = Math.min(Number(end), size);
    return length === 0 ? "unsatisfiable" : { offset: size - length, length };
  }
  const offset = Number(start);
  if (offset >= size) return "unsatisfiable";
  const last = end === "" ? size - 1 : Math.min(Number(end), size - 1);
  if (last < offset) return undefined;
  return { offset, length: last - offset + 1 };
}
