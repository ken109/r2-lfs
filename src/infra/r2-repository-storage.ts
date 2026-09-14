import type { RepositoryStorage } from "../app/ports.ts";
import { R2_MAX_SINGLE_UPLOAD_BYTES } from "../domain/batch.ts";
import { streamCopy } from "./r2-copy.ts";

/** R2 refuses to delete or overwrite an object a bucket lock rule protects (10069). */
const LOCKED = /\(10069\)|bucket lock|locked/i;

const COPY_PART_BYTES = 32 * 1024 ** 2;

const isLocked = (err: unknown) => LOCKED.test(err instanceof Error ? err.message : String(err));

export class R2RepositoryStorage implements RepositoryStorage {
  private readonly bucket: R2Bucket;
  private readonly ssecKey: string | undefined;
  private readonly singleUploadBytes: number;

  /** With `ssecKey`, copies are encrypted with it; sources stored before it was set are still read. */
  constructor(bucket: R2Bucket, ssecKey?: string, sizes: { singleUploadBytes?: number } = {}) {
    this.bucket = bucket;
    this.ssecKey = ssecKey;
    this.singleUploadBytes = sizes.singleUploadBytes ?? R2_MAX_SINGLE_UPLOAD_BYTES;
  }

  async list(prefix: string, cursor?: string) {
    const page = await this.bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    return {
      objects: page.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded, storageClass: o.storageClass })),
      ...(page.truncated ? { cursor: page.cursor } : {}),
    };
  }

  async head(key: string) {
    const object = await this.bucket.head(key);
    return object ? { size: object.size, storageClass: object.storageClass } : null;
  }

  async copy(source: string, target: string, opts: { sha256: string; storageClass?: "Standard" | "InfrequentAccess" }) {
    const head = await this.bucket.head(source);
    if (!head) return "missing" as const;
    const object = await this.bucket.get(source, head.ssecKeyMd5 && this.ssecKey ? { ssecKey: this.ssecKey } : {});
    if (!object) return "missing" as const;
    try {
      const result = await streamCopy(this.bucket, object.body, target, {
        size: object.size,
        sha256: opts.sha256,
        singleUploadBytes: this.singleUploadBytes,
        copyPartBytes: COPY_PART_BYTES,
        put: {
          ...(this.ssecKey ? { ssecKey: this.ssecKey } : {}),
          ...(opts.storageClass ? { storageClass: opts.storageClass } : { storageClass: head.storageClass }),
        },
      });
      return result === "stored" ? ("copied" as const) : result;
    } catch (err) {
      if (isLocked(err)) return "locked" as const;
      throw err;
    }
  }

  async delete(key: string) {
    try {
      await this.bucket.delete(key);
      return "deleted" as const;
    } catch (err) {
      if (isLocked(err)) return "locked" as const;
      throw err;
    }
  }
}
