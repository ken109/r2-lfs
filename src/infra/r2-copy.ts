import { toHex } from "./crypto.ts";

export interface StreamCopyOptions {
  size: number;
  /** The copy is kept only if its content hashes to this. */
  sha256: string;
  /** Objects above this are copied in parts; R2 takes at most 5 GiB in one request. */
  singleUploadBytes: number;
  copyPartBytes: number;
  /** Such as the SSE-C key or storage class of the copy. */
  put: { ssecKey?: string; storageClass?: string };
}

const CHECKSUM_ERROR = /sha-?256|digest|checksum/i;

/** Streams `body` into `target`, keeping it only if it hashes to `sha256`. */
export async function streamCopy(
  bucket: R2Bucket,
  body: ReadableStream,
  target: string,
  opts: StreamCopyOptions,
): Promise<"stored" | "checksum-mismatch"> {
  if (opts.size <= opts.singleUploadBytes) {
    try {
      // R2 refuses the write unless the body hashes to the digest.
      await bucket.put(target, body.pipeThrough(new FixedLengthStream(opts.size)), { sha256: opts.sha256, ...opts.put });
      return "stored";
    } catch (err) {
      if (CHECKSUM_ERROR.test(err instanceof Error ? err.message : String(err))) return "checksum-mismatch";
      throw err;
    }
  }

  // Too big for one request: copy in parts and hash along the way, completing only if the hash matches.
  const upload = await bucket.createMultipartUpload(target, opts.put);
  const digest = new crypto.DigestStream("SHA-256");
  const hasher = digest.getWriter();
  const parts: R2UploadedPart[] = [];
  const reader = body.getReader();
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
    parts.push(await upload.uploadPart(parts.length + 1, part, opts.put.ssecKey ? { ssecKey: opts.put.ssecKey } : {}));
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await hasher.write(value);
      buffered.push(value);
      bufferedBytes += value.byteLength;
      if (bufferedBytes >= opts.copyPartBytes) await flush();
    }
    if (bufferedBytes > 0) await flush();
    await hasher.close();
    if (toHex(await digest.digest) !== opts.sha256) {
      await upload.abort();
      return "checksum-mismatch";
    }
    await upload.complete(parts);
    return "stored";
  } catch (err) {
    await upload.abort().catch(() => {});
    throw err;
  }
}
