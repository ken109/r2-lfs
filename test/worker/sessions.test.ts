import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";
import { clearHostCache, type Fetcher } from "../../src/infra/host-permissions.ts";
import { clearRepositoryIdentitiesCache } from "../../src/infra/r2-repository-identities.ts";
import { clearSessionKeyCache, HmacSessionTokens } from "../../src/infra/session-tokens.ts";
import { type BatchObjectResult, type LfsLock, SESSION_KEY_KEY, type SessionResponse } from "../../src/shared/contract.ts";
import { basic, blob, type CallOptions, envWith, noHost, ORIGIN, call as send } from "./helpers.ts";

const WRITE_TOKEN = "w".repeat(32);

const makeEnv = envWith({ AUTH_MODE: "token", TRANSFER_MODE: "proxy", AUTH_TOKENS: `acme/*:rw:${WRITE_TOKEN}` });

const call = (e: Env, path: string, authorization: string | undefined, opts: CallOptions = {}) =>
  send(e, path, { ...(authorization ? { authorization } : {}), ...opts });

async function session(e: Env, repo: string, authorization: string) {
  const res = await call(e, `/${repo}/r2-lfs/session`, authorization, { json: {} });
  return { status: res.status, body: (await res.json()) as SessionResponse & { message?: string } };
}

beforeEach(() => {
  clearSessionKeyCache();
  clearHostCache();
  clearRepositoryIdentitiesCache();
});

describe("transfer action tokens", () => {
  it("give each object's transfer its own token instead of repeating the client's credentials", async () => {
    const e = makeEnv();
    const object = await blob();
    const other = await blob();
    const res = await call(e, "/acme/actions/objects/batch", basic(WRITE_TOKEN), {
      json: { operation: "upload", objects: [object, other].map(({ oid, size }) => ({ oid, size })) },
    });
    const { objects } = (await res.json()) as { objects: BatchObjectResult[] };
    const upload = objects[0]!.actions!.upload!;
    const auth = upload.header!.Authorization!;
    expect(auth).toMatch(/^Bearer r2lfs-s1\./);
    expect(JSON.stringify(objects)).not.toContain(WRITE_TOKEN);
    expect(upload.expires_in).toBe(12 * 3600);

    expect((await call(e, upload.href, auth, { method: "PUT", body: object.data })).status).toBe(200);
    // The token covers this object and its verify call, and nothing else.
    expect((await call(e, objects[0]!.actions!.verify!.href, auth, { json: { oid: object.oid, size: object.size } })).status).toBe(200);
    expect((await call(e, `/acme/actions/objects/${other.oid}`, auth, { method: "PUT", body: other.data })).status).toBe(403);
    expect((await call(e, "/acme/actions/objects/verify", auth, { json: { oid: other.oid, size: other.size } })).status).toBe(403);
    expect((await call(e, "/acme/actions/objects/batch", auth, { json: { operation: "download", objects: [] } })).status).toBe(403);
    expect((await call(e, "/acme/actions/locks", auth, { json: { path: "a.bin" } })).status).toBe(403);
    expect((await call(e, "/acme/other/objects/batch", auth, { json: { operation: "download", objects: [] } })).status).toBe(404);

    // A download action's token only reads.
    const down = await call(e, "/acme/actions/objects/batch", basic(WRITE_TOKEN), {
      json: { operation: "download", objects: [{ oid: object.oid, size: object.size }] },
    });
    const read = ((await down.json()) as { objects: BatchObjectResult[] }).objects[0]!.actions!.download!;
    expect((await call(e, read.href, read.header!.Authorization, { method: "GET" })).status).toBe(200);
    expect((await call(e, read.href, read.header!.Authorization, { method: "PUT", body: object.data })).status).toBe(403);
  });
});

describe("session endpoint", () => {
  it("trades credentials for a short-lived token that works until it expires or the key is deleted", async () => {
    const e = makeEnv();
    const { status, body } = await session(e, "acme/sessions", basic(WRITE_TOKEN));
    expect(status).toBe(200);
    expect(body.permission).toBe("write");
    expect(body.token).toMatch(/^r2lfs-s1\./);
    const expiresIn = Date.parse(body.expires_at) - Date.now();
    expect(expiresIn).toBeGreaterThan(3500_000);
    expect(expiresIn).toBeLessThanOrEqual(3600_000);

    const bearer = `Bearer ${body.token}`;
    expect((await call(e, "/acme/sessions/objects/batch", bearer, { json: { operation: "upload", objects: [] } })).status).toBe(200);
    // git sends it as a Basic password, the way a credential helper answers.
    const lock = await call(e, "/acme/sessions/locks", `Basic ${btoa(`r2-lfs:${body.token}`)}`, {
      json: { path: `scene-${Date.now()}.blend` },
    });
    expect(lock.status).toBe(201);
    expect(((await lock.json()) as { lock: LfsLock }).lock.owner.name).toBeTruthy();

    // Only for the repository it was issued for, and never traded for another token.
    expect((await call(e, "/acme/elsewhere/objects/batch", bearer, { json: { operation: "download", objects: [] } })).status).toBe(404);
    expect((await session(e, "acme/sessions", bearer)).status).toBe(403);

    const tampered = `Bearer ${body.token.slice(0, -2)}${body.token.endsWith("A") ? "B" : "A"}`;
    expect((await call(e, "/acme/sessions/objects/batch", tampered, { json: { operation: "download", objects: [] } })).status).toBe(401);

    await env.BUCKET.delete(SESSION_KEY_KEY);
    clearSessionKeyCache();
    expect((await call(e, "/acme/sessions/objects/batch", bearer, { json: { operation: "download", objects: [] } })).status).toBe(401);
  });

  it("refuses expired tokens with 401 so git-lfs asks its credential helper again", async () => {
    const e = makeEnv();
    const past = new HmacSessionTokens(env.BUCKET, () => Date.now() - 2 * 3600_000);
    const expired = await past.mint({ repo: "acme/old", permission: "write", expires: Math.floor(Date.now() / 1000) - 60 });
    const res = await call(e, "/acme/old/objects/batch", `Bearer ${expired}`, { json: { operation: "download", objects: [] } });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("expired");
  });

  it("names the Git host account in the token, so file locks show who holds them", async () => {
    const repo = "https://api.github.com/repos/acme/github-session";
    const fetcher: Fetcher = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === repo) return Response.json({ id: 7, permissions: { pull: true, push: true } });
      if (url === "https://api.github.com/user") return Response.json({ login: "octocat" });
      return new Response("{}", { status: 404 });
    };
    const e = makeEnv({ AUTH_MODE: "github" });
    const res = await handle(
      new Request(`${ORIGIN}/acme/github-session.git/info/lfs/r2-lfs/session`, {
        method: "POST",
        headers: { Authorization: basic("gho_x") },
      }),
      e,
      { fetch: fetcher },
    );
    const body = (await res.json()) as SessionResponse;
    expect(res.status).toBe(200);
    const lock = await handle(
      new Request(`${ORIGIN}/acme/github-session/locks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${body.token}` },
        body: JSON.stringify({ path: "hero.blend" }),
      }),
      e,
      { fetch: noHost },
    );
    expect(((await lock.json()) as { lock: LfsLock }).lock.owner.name).toBe("octocat");
  });
});
