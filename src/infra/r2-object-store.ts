import type { ObjectStore } from "../app/ports.ts";
import { toHex } from "./crypto.ts";

const USAGE_TTL_MS = 60_000;
const usageCache = new Map<string, { bytes: number; expires: number }>();

export function clearUsageCache(): void {
  usageCache.clear();
}

export class R2ObjectStore implements ObjectStore {
  private readonly bucket: R2Bucket;
  private readonly ssecKey: string | undefined;

  /** With `ssecKey`, new objects are encrypted with SSE-C; objects stored before it was set are still read. */
  constructor(bucket: R2Bucket, ssecKey?: string) {
    this.bucket = bucket;
    this.ssecKey = ssecKey;
  }

  /** Reading an SSE-C object needs the key; R2 tells which objects are encrypted without it. */
  private async open(key: string, range?: { offset: number; length: number }): Promise<R2ObjectBody | null> {
    const head = await this.bucket.head(key);
    if (!head) return null;
    return this.bucket.get(key, { ...(head.ssecKeyMd5 && this.ssecKey ? { ssecKey: this.ssecKey } : {}), ...(range ? { range } : {}) });
  }

  async head(key: string) {
    const object = await this.bucket.head(key);
    return object ? { size: object.size } : null;
  }

  async get(key: string, range?: { offset: number; length: number }) {
    const object = await this.open(key, range);
    return object ? { body: object.body, size: object.size } : null;
  }

  async sha256(key: string) {
    const object = await this.open(key);
    if (!object) return undefined;
    const digest = new crypto.DigestStream("SHA-256");
    await object.body.pipeTo(digest);
    return toHex(await digest.digest);
  }

  async usage(prefix: string) {
    const hit = usageCache.get(prefix);
    if (hit && hit.expires > Date.now()) return hit.bytes;
    let bytes = 0;
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
      for (const object of page.objects) bytes += object.size;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    usageCache.set(prefix, { bytes, expires: Date.now() + USAGE_TTL_MS });
    return bytes;
  }

  async mark(key: string) {
    await this.bucket.put(key, new Uint8Array(0));
  }

  async delete(key: string) {
    await this.bucket.delete(key);
  }

  async put(key: string, body: ReadableStream, sha256: string) {
    try {
      // R2 rejects the write if the body does not hash to the given digest.
      await this.bucket.put(key, body, { sha256, ...(this.ssecKey ? { ssecKey: this.ssecKey } : {}) });
      return "stored" as const;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/sha-?256|digest|checksum/i.test(message)) return "checksum-mismatch" as const;
      throw err;
    }
  }
}
