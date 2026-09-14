import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";

const ORIGIN = "https://lfs.example.com";
const WRITE_TOKEN = "w".repeat(32);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BUCKET: env.BUCKET,
    LOCKS: env.LOCKS,
    ALLOWED_REPOS: "acme/*",
    AUTH_MODE: "token",
    STORAGE_LAYOUT: "per-repo",
    TRANSFER_MODE: "proxy",
    PROXY_MAX_UPLOAD_MB: "1",
    AUTH_TOKENS: `acme/*:rw:${WRITE_TOKEN}`,
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

describe("ranged downloads", () => {
  it("resumes a download from an offset, a suffix or a closed range", async () => {
    const e = makeEnv();
    const object = await blob(1000);
    await env.BUCKET.put(`acme/range/${object.oid}`, object.data);
    const get = (range?: string) => call(e, `/acme/range/objects/${object.oid}`, range ? { headers: { Range: range } } : {});

    const whole = await get();
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
    await whole.arrayBuffer();

    const tail = await get("bytes=900-");
    expect(tail.status).toBe(206);
    expect(tail.headers.get("Content-Range")).toBe("bytes 900-999/1000");
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(object.data.slice(900));

    const suffix = await get("bytes=-10");
    expect(suffix.headers.get("Content-Range")).toBe("bytes 990-999/1000");
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(object.data.slice(990));

    const closed = await get("bytes=10-19");
    expect(closed.headers.get("Content-Length")).toBe("10");
    expect(new Uint8Array(await closed.arrayBuffer())).toEqual(object.data.slice(10, 20));

    expect((await get("bytes=1000-")).status).toBe(416);
    // Several ranges, or one ending before it starts, may be answered with the whole object.
    const several = await get("bytes=0-1,5-6");
    expect(several.status).toBe(200);
    await several.arrayBuffer();
  });
});
