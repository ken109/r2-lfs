import type { MultipartStore } from "../app/ports.ts";
import { R2_MAX_SINGLE_UPLOAD_BYTES } from "../domain/batch.ts";
import { toHex } from "./crypto.ts";

/** R2's error for an upload id that does not exist, or belongs to another key. */
const NO_SUCH_UPLOAD = /\(10024\)|does not exist/;

/** Parts of a copy, held in memory one at a time, well within a Worker's 128 MB. */
const COPY_PART_BYTES = 32 * 1024 ** 2;

export class R2MultipartStore implements MultipartStore {
  private readonly bucket: R2Bucket;
  private readonly ssecKey: string | undefined;
  private readonly singleUploadBytes: number;
  private readonly copyPartBytes: number;

  /** Objects above `singleUploadBytes` are copied in parts. The size options exist for tests, which cannot hold gigabytes. */
  constructor(bucket: R2Bucket, ssecKey?: string, sizes: { singleUploadBytes?: number; copyPartBytes?: number } = {}) {
    this.bucket = bucket;
    this.ssecKey = ssecKey;
    this.singleUploadBytes = sizes.singleUploadBytes ?? R2_MAX_SINGLE_UPLOAD_BYTES;
    this.copyPartBytes = sizes.copyPartBytes ?? COPY_PART_BYTES;
  }

  private get keyOptions() {
    return this.ssecKey ? { ssecKey: this.ssecKey } : {};
  }

  async create(key: string): Promise<string> {
    return (await this.bucket.createMultipartUpload(key, this.keyOptions)).uploadId;
  }

  async uploadPart(key: string, uploadId: string, partNumber: number, body: ReadableStream) {
    try {
      const part = await this.bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, body, this.keyOptions);
      return { partNumber: part.partNumber, etag: part.etag };
    } catch (err) {
      if (NO_SUCH_UPLOAD.test(err instanceof Error ? err.message : String(err))) return undefined;
      throw err;
    }
  }

  async complete(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
    await this.bucket.resumeMultipartUpload(key, uploadId).complete(parts);
  }

  async abort(key: string, uploadId: string) {
    await this.bucket.resumeMultipartUpload(key, uploadId).abort();
  }

  async promote(source: string, target: string, sha256: string, size: number) {
    const object = await this.bucket.get(source, this.keyOptions);
    if (!object) return "checksum-mismatch" as const;

    if (size <= this.singleUploadBytes) {
      try {
        // R2 refuses the write unless the body hashes to the oid.
        await this.bucket.put(target, object.body.pipeThrough(new FixedLengthStream(size)), { sha256, ...this.keyOptions });
        return "stored" as const;
      } catch (err) {
        if (/sha-?256|digest|checksum/i.test(err instanceof Error ? err.message : String(err))) return "checksum-mismatch" as const;
        throw err;
      }
    }

    // Too big for one request: copy in parts and hash along the way, completing only if the hash matches.
    const upload = await this.bucket.createMultipartUpload(target, this.keyOptions);
    const digest = new crypto.DigestStream("SHA-256");
    const hasher = digest.getWriter();
    const parts: R2UploadedPart[] = [];
    const reader = object.body.getReader();
    let buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    const flush = async () => {
      const part = new Uint8Array(bufferedBytes);
      let offset = 0;
      for (const chunk of buffered) {
        part.set(chunk, offset);
        offset += chunk.byteLength;
      }
      buffered = [];
      bufferedBytes = 0;
      parts.push(await upload.uploadPart(parts.length + 1, part, this.keyOptions));
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await hasher.write(value);
        buffered.push(value);
        bufferedBytes += value.byteLength;
        if (bufferedBytes >= this.copyPartBytes) await flush();
      }
      if (bufferedBytes > 0) await flush();
      await hasher.close();
      if (toHex(await digest.digest) !== sha256) {
        await upload.abort();
        return "checksum-mismatch" as const;
      }
      await upload.complete(parts);
      return "stored" as const;
    } catch (err) {
      await upload.abort().catch(() => {});
      throw err;
    }
  }
}
