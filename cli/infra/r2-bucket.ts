import { createHash } from "node:crypto";

import { AwsClient } from "aws4fetch";

import { type Bucket, type BucketObject, ConflictError, type WriteResult } from "../app/ports.ts";
import { UsageError } from "../domain/errors.ts";
import type { StoredObject } from "../domain/objects.ts";

function decodeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Parses one page of an S3 ListObjectsV2 response. */
export function parseListObjects(xml: string): { objects: StoredObject[]; nextToken: string | undefined } {
  const objects: StoredObject[] = [];
  for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const field = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body!)?.[1];
    const key = field("Key");
    const size = field("Size");
    const modified = field("LastModified");
    if (key === undefined || size === undefined || modified === undefined) continue;
    objects.push({
      key: decodeXml(key),
      size: Number(size),
      lastModified: new Date(modified),
      storageClass: field("StorageClass") ?? "STANDARD",
    });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, nextToken: truncated && token ? decodeXml(token) : undefined };
}

const ENV_NAMES = ["R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

export function r2Configured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ENV_NAMES.every((name) => env[name]);
}

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/** The bucket through R2's S3 API: listing, deleting and copying, which the LFS protocol cannot do. */
/** SSE-C headers for a copy: the key to decrypt the source with and to encrypt the copy with. */
export function ssecHeaders(key: string): Record<string, string> {
  const bytes = /^[0-9a-f]{64}$/i.test(key) ? Buffer.from(key, "hex") : Buffer.from(key, "base64");
  if (bytes.length !== 32) throw new UsageError("R2_LFS_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64");
  const encoded = bytes.toString("base64");
  const md5 = createHash("md5").update(bytes).digest("base64");
  const headers: Record<string, string> = {};
  for (const prefix of ["x-amz-server-side-encryption-customer", "x-amz-copy-source-server-side-encryption-customer"]) {
    headers[`${prefix}-algorithm`] = "AES256";
    headers[`${prefix}-key`] = encoded;
    headers[`${prefix}-key-md5`] = md5;
  }
  return headers;
}

export class R2Bucket implements Bucket {
  readonly name: string;
  private readonly ssec: Record<string, string> | undefined;
  private readonly client: AwsClient;
  private readonly endpoint: string;

  constructor(opts: {
    bucket: string;
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint?: string;
    /** How often aws4fetch retries a 5xx response with backoff; its default is 10. */
    retries?: number;
    /** The server's ENCRYPTION_KEY, as 64 hex characters or base64. */
    encryptionKey?: string;
  }) {
    this.name = opts.bucket;
    this.ssec = opts.encryptionKey ? ssecHeaders(opts.encryptionKey) : undefined;
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: "s3",
      region: "auto",
      ...(opts.retries === undefined ? {} : { retries: opts.retries }),
    });
    const base = (opts.endpoint ?? `https://${opts.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, "");
    this.endpoint = `${base}/${opts.bucket}`;
  }

  /** R2_ENDPOINT overrides the host, e.g. for EU jurisdiction buckets. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): R2Bucket {
    const missing = ENV_NAMES.filter((name) => !env[name]);
    if (missing.length > 0) {
      throw new UsageError(
        `this command needs R2 API credentials; set ${missing.join(", ")}\n` +
          "Create a token with Object Read & Write on the bucket under R2 > Manage API tokens.",
      );
    }
    return new R2Bucket({
      bucket: env.R2_BUCKET_NAME!,
      accountId: env.R2_ACCOUNT_ID!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      endpoint: env.R2_ENDPOINT,
      ...(env.R2_LFS_ENCRYPTION_KEY ? { encryptionKey: env.R2_LFS_ENCRYPTION_KEY } : {}),
    });
  }

  private async result(res: Response): Promise<WriteResult> {
    const text = await res.text();
    // S3 can report a failed copy inside a 200 response.
    const failed = !res.ok || /<Error>/.test(text);
    const message = /<Message>([\s\S]*?)<\/Message>/.exec(text)?.[1] ?? /<Code>([\s\S]*?)<\/Code>/.exec(text)?.[1] ?? "";
    return { ok: !failed, status: res.status, message: decodeXml(message) };
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const all: StoredObject[] = [];
    let token: string | undefined;
    do {
      const url = new URL(this.endpoint);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", prefix);
      if (token) url.searchParams.set("continuation-token", token);
      const res = await this.client.fetch(url);
      if (!res.ok) throw new Error(`listing ${prefix} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      const page = parseListObjects(await res.text());
      all.push(...page.objects);
      token = page.nextToken;
    } while (token);
    return all;
  }

  async get(key: string): Promise<BucketObject | undefined> {
    const res = await this.client.fetch(`${this.endpoint}/${encodeKey(key)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`reading ${key} failed: ${res.status}`);
    return { text: () => res.text(), etag: res.headers.get("ETag") };
  }

  async put(key: string, body: string, opts: { expectEtag?: string | null } = {}): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.expectEtag === null) headers["If-None-Match"] = "*";
    else if (opts.expectEtag !== undefined) headers["If-Match"] = opts.expectEtag;
    const result = await this.result(await this.client.fetch(`${this.endpoint}/${encodeKey(key)}`, { method: "PUT", body, headers }));
    if (result.status === 412) throw new ConflictError(`${key} changed while this command ran; try again`);
    if (!result.ok) throw new Error(`writing ${key} failed: ${result.status} ${result.message}`);
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.client.fetch(`${this.endpoint}/${encodeKey(key)}`, { method: "HEAD" });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`checking ${key} failed: ${res.status}`);
    return true;
  }

  async delete(key: string): Promise<WriteResult> {
    return this.result(await this.client.fetch(`${this.endpoint}/${encodeKey(key)}`, { method: "DELETE" }));
  }

  get encrypted(): boolean {
    return this.ssec !== undefined;
  }

  async copy(source: string, target: string, storageClass?: "STANDARD" | "STANDARD_IA"): Promise<WriteResult> {
    const headers: Record<string, string> = { "x-amz-copy-source": `/${this.name}/${encodeKey(source)}`, ...this.ssec };
    if (storageClass) headers["x-amz-storage-class"] = storageClass;
    // Copying an object onto itself is only allowed when something changes, like the storage class.
    if (source === target) headers["x-amz-metadata-directive"] = "REPLACE";
    return this.result(await this.client.fetch(`${this.endpoint}/${encodeKey(target)}`, { method: "PUT", headers }));
  }
}
