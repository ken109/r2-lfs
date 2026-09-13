import type { ObjectStore } from "../app/ports.ts";

export class R2ObjectStore implements ObjectStore {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async head(key: string) {
    const object = await this.bucket.head(key);
    return object ? { size: object.size } : null;
  }

  async get(key: string) {
    const object = await this.bucket.get(key);
    return object ? { body: object.body, size: object.size } : null;
  }

  async put(key: string, body: ReadableStream, sha256: string) {
    try {
      // R2 rejects the write if the body does not hash to the given digest.
      await this.bucket.put(key, body, { sha256 });
      return "stored" as const;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/sha-?256|digest|checksum/i.test(message)) return "checksum-mismatch" as const;
      throw err;
    }
  }
}
