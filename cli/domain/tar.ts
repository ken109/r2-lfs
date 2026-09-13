// The tar format (ustar with PAX extensions), kept free of I/O so part sizes can be planned up front.

import { UsageError } from "./errors.ts";

export const BLOCK = 512;
export const END_BYTES = BLOCK * 2;
const NAME_FIELD = 100;

export type TarSource = { kind: "file"; path: string } | { kind: "buffer"; data: Uint8Array } | { kind: "symlink"; target: string };

export interface TarEntry {
  name: string;
  size: number;
  mode: number;
  source: TarSource;
}

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).length;

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

export function paddingFor(size: number): number {
  const rest = size % BLOCK;
  return rest === 0 ? 0 : BLOCK - rest;
}

export function encodeHeader(fields: {
  name: string;
  size: number;
  mode: number;
  mtime: number;
  type: "0" | "2" | "x";
  linkname?: string;
}): Uint8Array {
  const buf = new Uint8Array(BLOCK);
  const put = (text: string, offset: number, max: number) => buf.set(utf8.encode(text).subarray(0, max), offset);
  put(fields.name, 0, NAME_FIELD);
  put(octal(fields.mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(fields.size, 12), 124, 12);
  put(octal(fields.mtime, 12), 136, 12);
  put("        ", 148, 8);
  put(fields.type, 156, 1);
  if (fields.linkname) put(fields.linkname, 157, NAME_FIELD);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  const checksum = buf.reduce((sum, byte) => sum + byte, 0);
  put(`${octal(checksum, 7)} `, 148, 8);
  return buf;
}

/** PAX records carry names and link targets that do not fit the 100-byte ustar fields. */
export function paxRecordsFor(entry: TarEntry): Uint8Array | undefined {
  const values: [string, string][] = [];
  if (byteLength(entry.name) > NAME_FIELD) values.push(["path", entry.name]);
  if (entry.source.kind === "symlink" && byteLength(entry.source.target) > NAME_FIELD) values.push(["linkpath", entry.source.target]);
  if (values.length === 0) return undefined;
  let body = "";
  for (const [key, value] of values) {
    const tail = ` ${key}=${value}\n`;
    const tailBytes = byteLength(tail);
    // The length prefix counts its own digits.
    let length = tailBytes + 1;
    while (String(length).length + tailBytes !== length) length = String(length).length + tailBytes;
    body += `${length}${tail}`;
  }
  return utf8.encode(body);
}

/** Bytes an entry occupies in the archive. */
export function entryBytes(entry: TarEntry): number {
  const pax = paxRecordsFor(entry);
  const data = entry.source.kind === "symlink" ? 0 : entry.size;
  return (pax ? BLOCK + pax.length + paddingFor(pax.length) : 0) + BLOCK + data + paddingFor(data);
}

/** Packs entries in order into parts no larger than `limit` bytes. */
export function splitParts(entries: readonly TarEntry[], limit: number): TarEntry[][] {
  const parts: TarEntry[][] = [];
  let current: TarEntry[] = [];
  let bytes = END_BYTES;
  for (const entry of entries) {
    const size = entryBytes(entry);
    if (size + END_BYTES > limit) throw new UsageError(`${entry.name} is too large for a ${limit}-byte part`);
    if (bytes + size > limit && current.length > 0) {
      parts.push(current);
      current = [];
      bytes = END_BYTES;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

export function partNames(repo: string, tag: string, count: number): string[] {
  const safeTag = tag.replace(/[^\w.-]+/g, "-");
  return Array.from({ length: count }, (_, i) => (count === 1 ? `${repo}-${safeTag}.tar` : `${repo}-${safeTag}.part${i + 1}.tar`));
}
