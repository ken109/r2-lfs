import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { parseConfig } from "../../src/domain/config.ts";
import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";
import { clearGithubCache, type Fetcher } from "../../src/infra/github-permissions.ts";
import { clearStoredTokensCache } from "../../src/infra/token-directory.ts";
import { TOKENS_KEY, type TokensFile } from "../../src/shared/contract.ts";

const ORIGIN = "https://lfs.example.com";
const WRITE_TOKEN = "w".repeat(32);
const READ_TOKEN = "r".repeat(32);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BUCKET: env.BUCKET,
    ALLOWED_OWNERS: "acme",
    AUTH_MODE: "token",
    STORAGE_LAYOUT: "per-repo",
    TRANSFER_MODE: "proxy",
    PROXY_MAX_UPLOAD_MB: "1",
    AUTH_TOKENS: `acme/*:rw:${WRITE_TOKEN},acme/app:r:${READ_TOKEN}`,
    ...overrides,
  };
}

const basic = (token: string) => `Basic ${btoa(`git:${token}`)}`;

const unexpectedFetch: Fetcher = () => {
  throw new Error("GitHub API must not be called");
};

interface CallOptions {
  method?: string;
  token?: string;
  authorization?: string;
  body?: BodyInit;
  json?: unknown;
  fetcher?: Fetcher;
}

function call(e: Env, path: string, opts: CallOptions = {}): Promise<Response> {
  const headers = new Headers();
  const authorization = opts.authorization ?? (opts.token ? basic(opts.token) : undefined);
  if (authorization) headers.set("Authorization", authorization);
  let body = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers.set("Content-Type", "application/vnd.git-lfs+json");
  }
  const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
  const request = new Request(url, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
  return handle(request, e, { fetch: opts.fetcher ?? unexpectedFetch });
}

/** Random content so each test works on objects no other test has stored. */
async function blob(size = 64): Promise<{ data: Uint8Array; oid: string; size: number }> {
  const data = crypto.getRandomValues(new Uint8Array(size));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const oid = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { data, oid, size };
}

interface BatchObject {
  oid: string;
  size: number;
  actions?: Record<string, { href: string; header?: Record<string, string>; expires_in?: number }>;
  error?: { code: number; message: string };
}

async function batch(
  e: Env,
  repoPath: string,
  operation: "upload" | "download",
  objects: { oid: string; size: number }[],
  opts: CallOptions = {},
): Promise<{ status: number; objects: BatchObject[]; body: { message?: string } }> {
  const res = await call(e, `${repoPath}/objects/batch`, {
    token: WRITE_TOKEN,
    ...opts,
    json: { operation, transfers: ["basic"], objects },
  });
  const body = (await res.json()) as { objects?: BatchObject[]; message?: string };
  return { status: res.status, objects: body.objects ?? [], body };
}

async function upload(e: Env, repoPath: string, object: { data: Uint8Array; oid: string; size: number }) {
  const { objects } = await batch(e, repoPath, "upload", [object]);
  const actions = objects[0]?.actions;
  if (!actions?.upload || !actions.verify) throw new Error(`no upload action: ${JSON.stringify(objects)}`);
  const put = await call(e, actions.upload.href, {
    method: "PUT",
    authorization: actions.upload.header?.Authorization,
    body: object.data,
  });
  expect(put.status).toBe(200);
  const verify = await call(e, actions.verify.href, {
    authorization: actions.verify.header?.Authorization,
    json: { oid: object.oid, size: object.size },
  });
  expect(verify.status).toBe(200);
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function storeTokens(tokens: TokensFile["tokens"]) {
  await env.BUCKET.put(TOKENS_KEY, JSON.stringify({ version: 1, tokens } satisfies TokensFile));
  clearStoredTokensCache();
}

function github(status: number, permissions?: { push: boolean; pull: boolean }) {
  const calls: Request[] = [];
  const fetcher: Fetcher = async (input, init) => {
    calls.push(new Request(input, init));
    return Response.json(permissions ? { permissions } : { message: "x" }, { status });
  };
  return { calls, fetcher };
}

beforeEach(() => {
  clearGithubCache();
  clearStoredTokensCache();
});

describe("routing and configuration", () => {
  it("answers the landing page without configuration", async () => {
    const res = await call(makeEnv({ ALLOWED_OWNERS: "" }), "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("r2-lfs is running");
  });

  it("reports every configuration problem at once", async () => {
    const res = await call(makeEnv({ ALLOWED_OWNERS: " ", STORAGE_LAYOUT: "flat" }), "/acme/app/objects/batch", {
      token: WRITE_TOKEN,
      json: { operation: "download", objects: [] },
    });
    expect(res.status).toBe(500);
    const { message } = (await res.json()) as { message: string };
    expect(message).toContain("ALLOWED_OWNERS is required");
    expect(message).toContain("STORAGE_LAYOUT must be one of");
  });

  it("does not echo tokens from malformed AUTH_TOKENS entries", () => {
    const error = String(thrown(() => parseConfig(makeEnv({ AUTH_TOKENS: "acme/*:admin:supersecretvalue1234" }))));
    expect(error).toMatch(/AUTH_TOKENS entry #1/);
    expect(error).not.toContain("supersecretvalue1234");
  });

  it("requires credentials for presigned mode when forced", () => {
    expect(() => parseConfig(makeEnv({ TRANSFER_MODE: "presigned" }))).toThrow(/R2_ACCOUNT_ID/);
  });

  it("accepts the .git/info/lfs URL style", async () => {
    const res = await batch(makeEnv(), "/acme/app.git/info/lfs", "download", []);
    expect(res.status).toBe(200);
  });

  it("rejects dot-segment repository names that could escape the prefix", async () => {
    // URL parsing already drops literal "/../"; "...git" survives it and strips to "..".
    for (const name of ["...git", "..git"]) {
      const res = await batch(makeEnv(), `/acme/${name}`, "download", []);
      expect(res.status).toBe(404);
    }
  });

  it("declines locking so git-lfs skips it", async () => {
    const res = await call(makeEnv(), "/acme/app/locks/verify", { token: WRITE_TOKEN, json: {} });
    expect(res.status).toBe(404);
  });
});

describe("authentication (token mode)", () => {
  it("rejects owners outside ALLOWED_OWNERS before checking credentials", async () => {
    const res = await batch(makeEnv(), "/other/app", "download", []);
    expect(res.status).toBe(403);
  });

  it("asks git for credentials when none are sent", async () => {
    const res = await call(makeEnv(), "/acme/app/objects/batch", { json: { operation: "download", objects: [] } });
    expect(res.status).toBe(401);
    expect(res.headers.get("LFS-Authenticate")).toBe('Basic realm="r2-lfs"');
  });

  it("rejects an unknown token", async () => {
    const res = await batch(makeEnv(), "/acme/app", "download", [], { token: "x".repeat(32) });
    expect(res.status).toBe(401);
  });

  it("limits a token to its scope", async () => {
    const res = await batch(makeEnv(), "/acme/other", "download", [], { token: READ_TOKEN });
    expect(res.status).toBe(401);
  });

  it("lets a read-only token download but not upload", async () => {
    const e = makeEnv();
    const object = await blob();
    await upload(e, "/acme/app", object);

    const up = await batch(e, "/acme/app", "upload", [object], { token: READ_TOKEN });
    expect(up.status).toBe(403);
    const down = await batch(e, "/acme/app", "download", [object], { token: READ_TOKEN });
    expect(down.status).toBe(200);
    expect(down.objects[0]?.actions?.download).toBeDefined();
  });
});

describe("stored tokens (r2-lfs token)", () => {
  it("accepts tokens stored in the bucket, within their scope and permission", async () => {
    const token = "stored-token-0123456789";
    await storeTokens([
      { id: "t1", label: "ci", scope: "acme/app", permission: "read", sha256: await sha256Hex(token), created: "2026-09-14" },
    ]);
    const e = makeEnv({ AUTH_TOKENS: "" });
    expect((await batch(e, "/acme/app", "download", [], { token })).status).toBe(200);
    expect((await batch(e, "/acme/app", "upload", [], { token })).status).toBe(403);
    expect((await batch(e, "/acme/other", "download", [], { token })).status).toBe(401);
    await env.BUCKET.delete(TOKENS_KEY);
  });

  it("stops accepting a token once it is removed from the file", async () => {
    const token = "revoked-token-0123456789";
    await storeTokens([{ id: "t2", label: "old", scope: "*", permission: "write", sha256: await sha256Hex(token), created: "2026-09-14" }]);
    const e = makeEnv({ AUTH_TOKENS: "" });
    expect((await batch(e, "/acme/app", "download", [], { token })).status).toBe(200);
    await storeTokens([]);
    expect((await batch(e, "/acme/app", "download", [], { token })).status).toBe(401);
    await env.BUCKET.delete(TOKENS_KEY);
  });
});

describe("server info", () => {
  it("reports non-secret settings for the CLI", async () => {
    const res = await call(makeEnv({ STORAGE_LAYOUT: "shared" }), "/_r2-lfs/info");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: "r2-lfs",
      authMode: "token",
      storageLayout: "shared",
      transfer: "proxy",
      proxyMaxUploadBytes: 1024 * 1024,
    });
  });

  it("lists configuration problems without leaking secrets", async () => {
    const res = await call(makeEnv({ ALLOWED_OWNERS: "", AUTH_TOKENS: "bad:entry:supersecretvalue1234" }), "/_r2-lfs/info");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("ALLOWED_OWNERS is required");
    expect(text).not.toContain("supersecretvalue1234");
  });
});

describe("proxy transfers", () => {
  it("round-trips an object through batch, PUT, verify and GET", async () => {
    const e = makeEnv();
    const object = await blob(1024);
    await upload(e, "/acme/app", object);

    expect(await env.BUCKET.head(`acme/app/${object.oid}`)).not.toBeNull();

    const { objects } = await batch(e, "/acme/app", "download", [object]);
    const download = objects[0]?.actions?.download;
    expect(download?.href).toBe(`${ORIGIN}/acme/app/objects/${object.oid}`);
    const res = await call(e, download!.href, { authorization: download!.header?.Authorization });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(object.data);
  });

  it("skips objects that are already stored", async () => {
    const e = makeEnv();
    const object = await blob();
    await upload(e, "/acme/app", object);
    const { objects } = await batch(e, "/acme/app", "upload", [object]);
    expect(objects[0]?.actions).toBeUndefined();
    expect(objects[0]?.error).toBeUndefined();
  });

  it("refuses content that does not hash to the oid", async () => {
    const e = makeEnv();
    const object = await blob();
    const other = await blob();
    const res = await call(e, `/acme/app/objects/${object.oid}`, {
      method: "PUT",
      token: WRITE_TOKEN,
      body: other.data,
    });
    expect(res.status).toBe(422);
    expect(await env.BUCKET.head(`acme/app/${object.oid}`)).toBeNull();
  });

  it("fails verify when nothing was uploaded", async () => {
    const object = await blob();
    const res = await call(makeEnv(), "/acme/app/objects/verify", {
      token: WRITE_TOKEN,
      json: { oid: object.oid, size: object.size },
    });
    expect(res.status).toBe(404);
  });

  it("points oversized objects at presigned mode instead of failing mid-transfer", async () => {
    const object = await blob();
    const { objects } = await batch(makeEnv(), "/acme/app", "upload", [{ oid: object.oid, size: 2 * 1024 * 1024 }]);
    expect(objects[0]?.error?.code).toBe(422);
    expect(objects[0]?.error?.message).toContain("presigned");
  });

  it("reports missing and malformed objects per object", async () => {
    const object = await blob();
    const { status, objects } = await batch(makeEnv(), "/acme/app", "download", [object, { oid: "not-an-oid", size: 1 }]);
    expect(status).toBe(200);
    expect(objects.map((o) => o.error?.code)).toEqual([404, 422]);
  });

  it("rejects hash algorithms other than sha256", async () => {
    const res = await call(makeEnv(), "/acme/app/objects/batch", {
      token: WRITE_TOKEN,
      json: { operation: "download", objects: [], hash_algo: "sha512" },
    });
    expect(res.status).toBe(409);
  });
});

describe("storage layout", () => {
  it("keeps per-repo objects apart", async () => {
    const e = makeEnv();
    const object = await blob();
    await upload(e, "/acme/app", object);
    const { objects } = await batch(e, "/acme/tools", "download", [object]);
    expect(objects[0]?.error?.code).toBe(404);
  });

  it("deduplicates across repositories in shared layout", async () => {
    const e = makeEnv({ STORAGE_LAYOUT: "shared" });
    const object = await blob();
    await upload(e, "/acme/app", object);
    expect(await env.BUCKET.head(`_shared/${object.oid}`)).not.toBeNull();

    const { objects } = await batch(e, "/acme/tools", "upload", [object]);
    expect(objects[0]?.actions).toBeUndefined();
  });

  it("lowercases owner and repo so GitHub's case-insensitive names share a prefix", async () => {
    const e = makeEnv();
    const object = await blob();
    await upload(e, "/ACME/App", object);
    expect(await env.BUCKET.head(`acme/app/${object.oid}`)).not.toBeNull();
  });
});

describe("presigned transfers", () => {
  const presignEnv = () =>
    makeEnv({
      TRANSFER_MODE: "auto",
      R2_ACCOUNT_ID: "0123456789abcdef",
      R2_BUCKET_NAME: "lfs-bucket",
      R2_ACCESS_KEY_ID: "AKIDEXAMPLE",
      R2_SECRET_ACCESS_KEY: "secret",
    });

  it("hands out signed R2 URLs for upload and keeps verify on the Worker", async () => {
    const object = await blob();
    const { objects } = await batch(presignEnv(), "/acme/app", "upload", [object]);
    const actions = objects[0]?.actions;
    const href = new URL(actions!.upload!.href);
    expect(href.host).toBe("0123456789abcdef.r2.cloudflarestorage.com");
    expect(href.pathname).toBe(`/lfs-bucket/acme/app/${object.oid}`);
    expect(href.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(href.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(actions!.upload!.header).toBeUndefined();
    expect(actions!.verify!.href).toBe(`${ORIGIN}/acme/app/objects/verify`);
  });

  it("does not cap upload size", async () => {
    const object = await blob();
    const { objects } = await batch(presignEnv(), "/acme/app", "upload", [{ oid: object.oid, size: 5 * 1024 * 1024 * 1024 }]);
    expect(objects[0]?.actions?.upload).toBeDefined();
  });

  it("falls back to proxy in auto mode without credentials", async () => {
    const object = await blob();
    const { objects } = await batch(makeEnv({ TRANSFER_MODE: "auto" }), "/acme/app", "upload", [object]);
    expect(objects[0]?.actions?.upload?.href).toBe(`${ORIGIN}/acme/app/objects/${object.oid}`);
  });
});

describe("authentication (github mode)", () => {
  const githubEnv = () => makeEnv({ AUTH_MODE: "github", AUTH_TOKENS: "" });
  const GH_TOKEN = "ghp_example";

  it("grants upload to collaborators with push access", async () => {
    const gh = github(200, { push: true, pull: true });
    const object = await blob();
    const { status, objects } = await batch(githubEnv(), "/acme/app", "upload", [object], {
      token: GH_TOKEN,
      fetcher: gh.fetcher,
    });
    expect(status).toBe(200);
    expect(objects[0]?.actions?.upload).toBeDefined();
    expect(gh.calls[0]?.url).toBe("https://api.github.com/repos/acme/app");
    expect(gh.calls[0]?.headers.get("Authorization")).toBe(`Bearer ${GH_TOKEN}`);
  });

  it("refuses upload with pull-only access", async () => {
    const gh = github(200, { push: false, pull: true });
    const object = await blob();
    const res = await batch(githubEnv(), "/acme/app", "upload", [object], { token: GH_TOKEN, fetcher: gh.fetcher });
    expect(res.status).toBe(403);
  });

  it("maps GitHub's hidden-repository 404 and bad-token 401", async () => {
    const hidden = await batch(githubEnv(), "/acme/app", "download", [], {
      token: GH_TOKEN,
      fetcher: github(404).fetcher,
    });
    expect(hidden.status).toBe(404);
    const bad = await batch(githubEnv(), "/acme/app", "download", [], {
      token: GH_TOKEN,
      fetcher: github(401).fetcher,
    });
    expect(bad.status).toBe(401);
  });

  it("caches the permission lookup for the transfer that follows a batch", async () => {
    const gh = github(200, { push: true, pull: true });
    const e = githubEnv();
    await batch(e, "/acme/app", "download", [], { token: GH_TOKEN, fetcher: gh.fetcher });
    await batch(e, "/acme/app", "download", [], { token: GH_TOKEN, fetcher: gh.fetcher });
    expect(gh.calls).toHaveLength(1);
  });

  it("does not share cached permissions between tokens", async () => {
    const e = githubEnv();
    await batch(e, "/acme/app", "download", [], { token: GH_TOKEN, fetcher: github(200, { push: true, pull: true }).fetcher });
    const other = github(404);
    const res = await batch(e, "/acme/app", "download", [], { token: "ghp_other", fetcher: other.fetcher });
    expect(other.calls).toHaveLength(1);
    expect(res.status).toBe(404);
  });
});
