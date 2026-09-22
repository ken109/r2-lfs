import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env.ts";
import { blob, type CallOptions, envWith, call as send } from "./helpers.ts";

const WRITE_TOKEN = "w".repeat(32);

const makeEnv = envWith({
  AUTH_MODE: "token",
  STORAGE_LAYOUT: "per-repo",
  TRANSFER_MODE: "proxy",
  PROXY_MAX_UPLOAD_MB: "1",
  AUTH_TOKENS: `acme/*:rw:${WRITE_TOKEN}`,
});

/** With the write token unless another is given. */
const call = (e: Env, path: string, opts: CallOptions = {}) => send(e, path, { token: WRITE_TOKEN, ...opts });

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
