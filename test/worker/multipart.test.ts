import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";
import { R2MultipartStore } from "../../src/infra/r2-multipart-store.ts";
import { type BatchResponse, MIN_PART_BYTES, MULTIPART_TRANSFER, type MultipartStart } from "../../src/shared/contract.ts";

const ORIGIN = "https://lfs.example.com";
const WRITE_TOKEN = "w".repeat(32);
const READ_TOKEN = "r".repeat(32);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BUCKET: env.BUCKET,
    LOCKS: env.LOCKS,
    ALLOWED_REPOS: "acme/*",
    AUTH_MODE: "token",
    STORAGE_LAYOUT: "per-repo",
    TRANSFER_MODE: "proxy",
    PROXY_MAX_UPLOAD_MB: "1",
    AUTH_TOKENS: `acme/*:rw:${WRITE_TOKEN},acme/*:r:${READ_TOKEN}`,
    ...overrides,
  };
}

function call(
  e: Env,
  path: string,
  opts: { method?: string; token?: string; body?: Uint8Array; json?: unknown; headers?: Record<string, string> } = {},
) {
  const headers = new Headers(opts.headers);
  headers.set("Authorization", `Basic ${btoa(`git:${opts.token ?? WRITE_TOKEN}`)}`);
  let body: BodyInit | undefined = opts.body;
  if (opts.body) headers.set("Content-Length", String(opts.body.byteLength));
  if (opts.json !== undefined) body = JSON.stringify(opts.json);
  const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
  return handle(new Request(url, { method: opts.method ?? (body ? "POST" : "GET"), headers, body }), e, { fetch });
}

async function sha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Random content; getRandomValues fills at most 65,536 bytes a call. */
async function blob(size: number, tamper = false) {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i += 65_536) crypto.getRandomValues(data.subarray(i, Math.min(size, i + 65_536)));
  const oid = await sha256(data);
  if (tamper) data[0] = data[0]! ^ 1;
  return { data, oid, size };
}

async function multipartUpload(e: Env, repo: string, object: { data: Uint8Array; oid: string; size: number }, token = WRITE_TOKEN) {
  const base = `/acme/${repo}/objects/${object.oid}/multipart`;
  const start = await call(e, base, { token, json: { size: object.size } });
  if (start.status !== 200) return start;
  const { uploadId, partSize } = (await start.json()) as MultipartStart;
  const parts = [];
  for (let offset = 0, n = 1; offset < object.size; offset += partSize, n++) {
    const res = await call(e, `${base}/${encodeURIComponent(uploadId)}/${n}`, {
      method: "PUT",
      token,
      body: object.data.slice(offset, offset + partSize),
    });
    expect(res.status).toBe(200);
    parts.push(await res.json());
  }
  return call(e, `${base}/${encodeURIComponent(uploadId)}/complete`, { token, json: { size: object.size, parts } });
}

describe("multipart uploads", () => {
  it("offers the multipart transfer to clients that list it, for uploads only", async () => {
    const e = makeEnv();
    const object = { oid: "a".repeat(64), size: 3 * 1024 ** 3 };
    const batch = async (operation: string, transfers: string[]) => {
      const res = await call(e, "/acme/app/objects/batch", { json: { operation, transfers, objects: [object] } });
      return (await res.json()) as BatchResponse;
    };

    const upload = await batch("upload", ["basic", MULTIPART_TRANSFER]);
    expect(upload.transfer).toBe(MULTIPART_TRANSFER);
    // Past the proxy limit, yet uploadable: parts go through the Worker one request at a time.
    expect(upload.objects[0]?.actions?.upload?.href).toBe(`${ORIGIN}/acme/app/objects/${object.oid}/multipart`);
    expect(upload.objects[0]?.actions?.verify).toBeUndefined();

    expect((await batch("upload", ["basic"])).transfer).toBe("basic");
    expect((await batch("download", ["basic", MULTIPART_TRANSFER])).transfer).toBe("basic");
  });

  it("keeps presigned uploads, which go straight to R2, for objects that fit in one", async () => {
    const e = makeEnv({
      TRANSFER_MODE: "auto",
      R2_ACCOUNT_ID: "0123456789abcdef",
      R2_BUCKET_NAME: "lfs-bucket",
      R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
      R2_SECRET_ACCESS_KEY: "secret",
    });
    const batch = async (size: number) => {
      const objects = [{ oid: "c".repeat(64), size }];
      const res = await call(e, "/acme/app/objects/batch", {
        json: { operation: "upload", transfers: ["basic", MULTIPART_TRANSFER], objects },
      });
      return (await res.json()) as BatchResponse;
    };
    expect((await batch(1024)).transfer).toBe("basic");
    expect((await batch(6 * 1024 ** 3)).transfer).toBe(MULTIPART_TRANSFER);
  });

  it("uploads in parts, checks the hash and moves the object into place", async () => {
    const e = makeEnv();
    const object = await blob(2 * MIN_PART_BYTES + 3);
    const res = await multipartUpload(e, "parts", object);
    expect(res.status).toBe(200);

    const stored = await env.BUCKET.get(`acme/parts/${object.oid}`);
    // By hash: toEqual over megabytes exhausts the test runtime's memory.
    expect(await sha256(await stored!.arrayBuffer())).toBe(object.oid);
    expect(await env.BUCKET.head(`_incoming/acme/parts/${object.oid}`)).toBeNull();
  });

  it("answers a repeated complete the same way, for clients that lost the first answer", async () => {
    const e = makeEnv({ STORAGE_LAYOUT: "shared" });
    const object = await blob(1000);
    const base = `/acme/again/objects/${object.oid}/multipart`;
    const { uploadId } = (await (await call(e, base, { json: { size: object.size } })).json()) as MultipartStart;
    const part = await (await call(e, `${base}/${encodeURIComponent(uploadId)}/1`, { method: "PUT", body: object.data })).json();
    const complete = () => call(e, `${base}/${encodeURIComponent(uploadId)}/complete`, { json: { size: object.size, parts: [part] } });
    expect((await complete()).status).toBe(200);
    expect((await complete()).status).toBe(200);

    // Another repository cannot use the same answer to claim the object.
    const other = await call(e, `/acme/elsewhere/objects/${object.oid}/multipart/${encodeURIComponent(uploadId)}/complete`, {
      json: { size: object.size, parts: [part] },
    });
    expect(other.status).toBe(422);
  });

  it("stores nothing when the parts do not hash to the oid", async () => {
    const e = makeEnv();
    const object = await blob(MIN_PART_BYTES + 10, true);
    const res = await multipartUpload(e, "tampered", object);
    expect(res.status).toBe(422);
    expect(await env.BUCKET.head(`acme/tampered/${object.oid}`)).toBeNull();
    expect(await env.BUCKET.head(`_incoming/acme/tampered/${object.oid}`)).toBeNull();
  });

  it("stores nothing when the size differs from the one started with", async () => {
    const e = makeEnv();
    const object = await blob(1000);
    const base = `/acme/size/objects/${object.oid}/multipart`;
    const { uploadId } = (await (await call(e, base, { json: { size: object.size } })).json()) as MultipartStart;
    const part = await (await call(e, `${base}/${encodeURIComponent(uploadId)}/1`, { method: "PUT", body: object.data })).json();
    const res = await call(e, `${base}/${encodeURIComponent(uploadId)}/complete`, { json: { size: 999, parts: [part] } });
    expect(res.status).toBe(422);
    expect(await env.BUCKET.head(`acme/size/${object.oid}`)).toBeNull();
  });

  it("marks membership in the shared layout, checking objects another repository already stored", async () => {
    const e = makeEnv({ STORAGE_LAYOUT: "shared" });
    const object = await blob(2000);
    expect((await multipartUpload(e, "first", object)).status).toBe(200);
    expect((await multipartUpload(e, "second", object)).status).toBe(200);
    expect(await env.BUCKET.head(`_members/acme/second/${object.oid}`)).not.toBeNull();

    const claim = { ...(await blob(2000)), oid: object.oid };
    expect((await multipartUpload(e, "third", claim)).status).toBe(422);
    expect(await env.BUCKET.head(`_members/acme/third/${object.oid}`)).toBeNull();
  });

  it("refuses read-only tokens, parts over the request limit and objects over MAX_OBJECT_MB", async () => {
    const e = makeEnv();
    const oid = "b".repeat(64);
    expect((await call(e, `/acme/app/objects/${oid}/multipart`, { token: READ_TOKEN, json: { size: 10 } })).status).toBe(403);
    expect(
      (await call(makeEnv({ MAX_OBJECT_MB: "1" }), `/acme/app/objects/${oid}/multipart`, { json: { size: 2 * 1024 ** 2 } })).status,
    ).toBe(422);

    const { uploadId } = (await (await call(e, `/acme/app/objects/${oid}/multipart`, { json: { size: 10 } })).json()) as MultipartStart;
    const tooBig = await call(e, `/acme/app/objects/${oid}/multipart/${encodeURIComponent(uploadId)}/1`, {
      method: "PUT",
      body: new Uint8Array(MIN_PART_BYTES + 1),
    });
    expect(tooBig.status).toBe(413);
  });

  it("does not let another repository finish an upload it did not start", async () => {
    const e = makeEnv();
    const object = await blob(100);
    const { uploadId } = (await (
      await call(e, `/acme/owner/objects/${object.oid}/multipart`, { json: { size: object.size } })
    ).json()) as MultipartStart;
    const res = await call(e, `/acme/other/objects/${object.oid}/multipart/${encodeURIComponent(uploadId)}/1`, {
      method: "PUT",
      body: object.data,
    });
    expect(res.status).toBe(404);
    expect(await env.BUCKET.head(`acme/other/${object.oid}`)).toBeNull();
  });
});

describe("aborting multipart uploads", () => {
  it("drops the parts, after which the upload id is gone", async () => {
    const e = makeEnv();
    const object = await blob(100);
    const base = `/acme/abort/objects/${object.oid}/multipart`;
    const { uploadId } = (await (await call(e, base, { json: { size: object.size } })).json()) as MultipartStart;
    expect((await call(e, `${base}/${encodeURIComponent(uploadId)}`, { method: "DELETE" })).status).toBe(200);
    const part = await call(e, `${base}/${encodeURIComponent(uploadId)}/1`, { method: "PUT", body: object.data });
    expect(part.status).toBe(404);
  });
});

describe("promoting uploads too large for one write", () => {
  it("copies in parts and completes only when the content hashes to the oid", async () => {
    const store = new R2MultipartStore(env.BUCKET, undefined, { singleUploadBytes: 0, copyPartBytes: MIN_PART_BYTES });
    const object = await blob(2 * MIN_PART_BYTES + 7);
    await env.BUCKET.put("promote/source", object.data);

    expect(await store.promote("promote/source", "promote/bad", "0".repeat(64), object.size)).toBe("checksum-mismatch");
    expect(await env.BUCKET.head("promote/bad")).toBeNull();

    expect(await store.promote("promote/source", "promote/good", object.oid, object.size)).toBe("stored");
    expect(await sha256(await (await env.BUCKET.get("promote/good"))!.arrayBuffer())).toBe(object.oid);
  });
});
