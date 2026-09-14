import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";
import { clearHostCache, type Fetcher } from "../../src/infra/host-permissions.ts";
import { clearJwtKeysCache } from "../../src/infra/jwt.ts";
import { clearRepositoryIdentitiesCache } from "../../src/infra/r2-repository-identities.ts";
import type { LfsLock } from "../../src/shared/contract.ts";
import { signingKey } from "./jwt-helpers.ts";

const ISSUER = "https://token.actions.githubusercontent.com";
const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: "r2-lfs",
  exp: now() + 300,
  repository: "acme/assets",
  actor: "octocat",
  workflow: "Build",
  ...over,
});

const makeEnv = (over: Partial<Env> = {}): Env => ({
  BUCKET: env.BUCKET,
  LOCKS: env.LOCKS,
  ALLOWED_REPOS: "acme/*",
  AUTH_MODE: "github",
  TRANSFER_MODE: "proxy",
  ACTIONS_OIDC: "read",
  ...over,
});

let repoCounter = 0;

async function setup() {
  const key = await signingKey("gh1");
  const calls: string[] = [];
  const fetcher: Fetcher = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === `${ISSUER}/.well-known/jwks`) return Response.json({ keys: [key.jwk] });
    throw new Error(`unexpected request to ${url}`);
  };
  const request = (e: Env, path: string, token: string, json: unknown) =>
    handle(
      new Request(`https://lfs.example.com${path}`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`x:${token}`)}`, "Content-Type": "application/vnd.git-lfs+json" },
        body: JSON.stringify(json),
      }),
      e,
      { fetch: fetcher },
    );
  return { key, calls, request };
}

beforeEach(() => {
  clearJwtKeysCache();
  clearHostCache();
});

describe("GitHub Actions OIDC", () => {
  it("lets a workflow read its own repository without asking the GitHub API", async () => {
    const { key, calls, request } = await setup();
    const token = await key.sign(claims());
    const res = await request(makeEnv(), "/acme/assets/objects/batch", token, { operation: "download", objects: [] });
    expect(res.status).toBe(200);
    expect(calls).toEqual([`${ISSUER}/.well-known/jwks`]);

    const upload = await request(makeEnv(), "/acme/assets/objects/batch", token, { operation: "upload", objects: [] });
    expect(upload.status).toBe(403);
    const writable = await request(makeEnv({ ACTIONS_OIDC: "write" }), "/acme/assets/objects/batch", token, {
      operation: "upload",
      objects: [],
    });
    expect(writable.status).toBe(200);
  });

  it("confines a workflow to its own repository and to tokens meant for this server", async () => {
    const { key, request } = await setup();
    const other = await request(makeEnv(), "/acme/other/objects/batch", await key.sign(claims()), { operation: "download", objects: [] });
    expect(other.status).toBe(404);
    expect(await other.text()).toContain("acme/assets");

    for (const token of [
      await key.sign(claims({ aud: "sts.amazonaws.com" })),
      await key.sign(claims({ iss: "https://evil.example.com" })),
      await key.sign(claims({ exp: now() - 600 })),
      await key.sign(claims({ repository: undefined })),
    ]) {
      expect((await request(makeEnv(), "/acme/assets/objects/batch", token, { operation: "download", objects: [] })).status).toBe(401);
    }
    const audience = makeEnv({ ACTIONS_OIDC_AUDIENCE: "https://lfs.example.com" });
    const matching = await key.sign(claims({ aud: "https://lfs.example.com" }));
    expect((await request(audience, "/acme/assets/objects/batch", matching, { operation: "download", objects: [] })).status).toBe(200);
  });

  it("does not accept Actions tokens unless ACTIONS_OIDC is set, and names locks after the actor", async () => {
    const { key, request } = await setup();
    const token = await key.sign(claims());
    const off = await handle(
      new Request("https://lfs.example.com/acme/assets/objects/batch", {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`x:${token}`)}` },
        body: JSON.stringify({ operation: "download", objects: [] }),
      }),
      makeEnv({ ACTIONS_OIDC: "" }),
      { fetch: async () => new Response("{}", { status: 401 }) },
    );
    expect(off.status).toBe(401);

    const repo = `assets-lock-${repoCounter++}-${Date.now()}`;
    const lockEnv = makeEnv({ ACTIONS_OIDC: "write" });
    const lockToken = await key.sign(claims({ repository: `acme/${repo}` }));
    const locked = await request(lockEnv, `/acme/${repo}/locks`, lockToken, { path: "build.zip" });
    expect(locked.status).toBe(201);
    expect(((await locked.json()) as { lock: LfsLock }).lock.owner.name).toBe("octocat (GitHub Actions)");
  });

  it("refuses a workflow of a different repository that reuses a recorded name", async () => {
    const { key, request } = await setup();
    const repo = `reused-${repoCounter++}-${Date.now()}`;
    const first = await key.sign(claims({ repository: `acme/${repo}`, repository_id: "9001" }));
    expect((await request(makeEnv(), `/acme/${repo}/objects/batch`, first, { operation: "download", objects: [] })).status).toBe(200);
    clearRepositoryIdentitiesCache();
    const second = await key.sign(claims({ repository: `acme/${repo}`, repository_id: "9002" }));
    const refused = await request(makeEnv(), `/acme/${repo}/objects/batch`, second, { operation: "download", objects: [] });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("reused");
  });

  it("reports the audience in server info", async () => {
    const res = await handle(new Request("https://lfs.example.com/_r2-lfs/info"), makeEnv(), { fetch: fetch });
    expect(await res.json()).toMatchObject({ actionsOidcAudience: "r2-lfs" });
    const invalid = await handle(new Request("https://lfs.example.com/_r2-lfs/info"), makeEnv({ ACTIONS_OIDC: "yes" }), { fetch: fetch });
    expect(await invalid.text()).toContain("ACTIONS_OIDC must be one of off, read, write");
  });
});
