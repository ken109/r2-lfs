import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";
import { clearGithubCache, type Fetcher } from "../../src/infra/github-permissions.ts";
import { clearStoredTokensCache } from "../../src/infra/token-directory.ts";
import type { LfsLock } from "../../src/shared/contract.ts";

const ORIGIN = "https://lfs.example.com";
const ALICE = "a".repeat(32);
const BOB = "b".repeat(32);
const ADMIN = "c".repeat(32);
const READER = "d".repeat(32);

let repoCounter = 0;
/** A repository no other test has used, so each test starts without locks. */
const freshRepo = () => `/acme/locks-${Date.now()}-${repoCounter++}`;

const tokenEnv = (): Env => ({
  BUCKET: env.BUCKET,
  LOCKS: env.LOCKS,
  ALLOWED_REPOS: "acme/*",
  AUTH_MODE: "token",
  TRANSFER_MODE: "proxy",
  AUTH_TOKENS: `acme/*:rw:${ALICE},acme/*:rw:${BOB},acme/*:admin:${ADMIN},acme/*:r:${READER}`,
});

const noGithub: Fetcher = () => {
  throw new Error("GitHub API must not be called");
};

async function call(e: Env, path: string, opts: { method?: string; token?: string; json?: unknown; fetcher?: Fetcher } = {}) {
  const headers = new Headers();
  if (opts.token) headers.set("Authorization", `Basic ${btoa(`git:${opts.token}`)}`);
  if (opts.json !== undefined) headers.set("Content-Type", "application/vnd.git-lfs+json");
  const request = new Request(`${ORIGIN}${path}`, {
    method: opts.method ?? (opts.json === undefined ? "GET" : "POST"),
    headers,
    ...(opts.json === undefined ? {} : { body: JSON.stringify(opts.json) }),
  });
  const res = await handle(request, e, { fetch: opts.fetcher ?? noGithub });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  clearGithubCache();
  clearStoredTokensCache();
});

describe("file locking (token mode)", () => {
  it("locks a path once, names the holder, and reports the existing lock on a conflict", async () => {
    const repo = freshRepo();
    const created = await call(tokenEnv(), `${repo}/locks`, {
      token: ALICE,
      json: { path: "scene.blend", ref: { name: "refs/heads/main" } },
    });
    expect(created.status).toBe(201);
    const lock = created.body.lock as LfsLock;
    expect(lock).toMatchObject({ path: "scene.blend", owner: { name: "AUTH_TOKENS #1" } });
    expect(Date.parse(lock.locked_at)).not.toBeNaN();

    const conflict = await call(tokenEnv(), `${repo}/locks`, { token: BOB, json: { path: "scene.blend" } });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ lock: { id: lock.id }, message: expect.stringContaining("AUTH_TOKENS #1") });

    expect((await call(tokenEnv(), `${repo}/locks`, { token: READER, json: { path: "other.blend" } })).status).toBe(403);
    expect((await call(tokenEnv(), `${repo}/locks`, { token: ALICE, json: {} })).status).toBe(422);
    expect((await call(tokenEnv(), `${repo}/locks`, { method: "DELETE", token: ALICE })).status).toBe(405);
  });

  it("keeps locks apart per repository, case-insensitively", async () => {
    const repo = freshRepo();
    expect((await call(tokenEnv(), `${repo}/locks`, { token: ALICE, json: { path: "a.psd" } })).status).toBe(201);
    expect(
      (await call(tokenEnv(), `${repo.toUpperCase().replace("/ACME", "/acme")}/locks`, { token: BOB, json: { path: "a.psd" } })).status,
    ).toBe(409);
    expect((await call(tokenEnv(), `${freshRepo()}/locks`, { token: BOB, json: { path: "a.psd" } })).status).toBe(201);
  });

  it("lists locks with filters and pages, for anyone who can read", async () => {
    const repo = freshRepo();
    const ids: string[] = [];
    for (const path of ["a.blend", "b.blend", "c.blend"]) {
      ids.push(((await call(tokenEnv(), `${repo}/locks`, { token: ALICE, json: { path } })).body.lock as LfsLock).id);
    }
    const first = await call(tokenEnv(), `${repo}/locks?limit=2`, { token: READER });
    expect(first.status).toBe(200);
    expect((first.body.locks as LfsLock[]).map((l) => l.path)).toEqual(["a.blend", "b.blend"]);
    const second = await call(tokenEnv(), `${repo}/locks?limit=2&cursor=${first.body.next_cursor as string}`, { token: READER });
    expect((second.body.locks as LfsLock[]).map((l) => l.path)).toEqual(["c.blend"]);
    expect(second.body.next_cursor).toBeUndefined();

    expect(((await call(tokenEnv(), `${repo}/locks?path=b.blend`, { token: READER })).body.locks as LfsLock[]).map((l) => l.id)).toEqual([
      ids[1],
    ]);
    expect(((await call(tokenEnv(), `${repo}/locks?id=${ids[2]}`, { token: READER })).body.locks as LfsLock[]).map((l) => l.path)).toEqual([
      "c.blend",
    ]);
    expect((await call(tokenEnv(), `${repo}/locks?limit=zero`, { token: READER })).status).toBe(422);
    expect((await call(tokenEnv(), `${repo}/locks`)).status).toBe(401);
  });

  it("splits locks into ours and theirs for verify, and needs write access", async () => {
    const repo = freshRepo();
    await call(tokenEnv(), `${repo}/locks`, { token: ALICE, json: { path: "mine.blend" } });
    await call(tokenEnv(), `${repo}/locks`, { token: BOB, json: { path: "bobs.blend" } });
    const verified = await call(tokenEnv(), `${repo}/locks/verify`, { token: ALICE, json: { ref: { name: "refs/heads/main" } } });
    expect(verified.status).toBe(200);
    expect((verified.body.ours as LfsLock[]).map((l) => l.path)).toEqual(["mine.blend"]);
    expect((verified.body.theirs as LfsLock[]).map((l) => l.path)).toEqual(["bobs.blend"]);
    expect((await call(tokenEnv(), `${repo}/locks/verify`, { token: READER, json: {} })).status).toBe(403);
    expect((await call(tokenEnv(), `${repo}/locks/verify`, { token: ALICE })).status).toBe(405);
  });

  it("lets holders unlock, and only admins force-unlock someone else's lock", async () => {
    const repo = freshRepo();
    const lock = (await call(tokenEnv(), `${repo}/locks`, { token: ALICE, json: { path: "hero.blend" } })).body.lock as LfsLock;

    const notYours = await call(tokenEnv(), `${repo}/locks/${lock.id}/unlock`, { token: BOB, json: {} });
    expect(notYours.status).toBe(403);
    expect(notYours.body.message).toContain("AUTH_TOKENS #1");
    expect((await call(tokenEnv(), `${repo}/locks/${lock.id}/unlock`, { token: BOB, json: { force: true } })).status).toBe(403);

    const forced = await call(tokenEnv(), `${repo}/locks/${lock.id}/unlock`, { token: ADMIN, json: { force: true } });
    expect(forced).toEqual({ status: 200, body: { lock } });
    expect((await call(tokenEnv(), `${repo}/locks/${lock.id}/unlock`, { token: ALICE, json: {} })).status).toBe(404);

    const again = (await call(tokenEnv(), `${repo}/locks`, { token: ALICE, json: { path: "hero.blend" } })).body.lock as LfsLock;
    expect((await call(tokenEnv(), `${repo}/locks/${again.id}/unlock`, { token: ALICE, json: {} })).status).toBe(200);
    expect(((await call(tokenEnv(), `${repo}/locks`, { token: READER })).body.locks as LfsLock[]).length).toBe(0);
  });
});

function github(login: string, permissions: Record<string, boolean>) {
  const fetcher: Fetcher = async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/user") return Response.json({ login });
    return Response.json({ permissions });
  };
  return fetcher;
}

const anonymousApp: Fetcher = async (input) =>
  String(input) === "https://api.github.com/user"
    ? new Response("{}", { status: 401 })
    : Response.json({ permissions: { push: true, pull: true } });

describe("file locking (github mode)", () => {
  const githubEnv = (): Env => ({ ...tokenEnv(), AUTH_MODE: "github", AUTH_TOKENS: "" });

  it("names locks by GitHub login and treats maintainers as admins", async () => {
    const repo = freshRepo();
    const octocat = github("octocat", { push: true, pull: true });
    const lock = (await call(githubEnv(), `${repo}/locks`, { token: "gho_octocat", json: { path: "rig.blend" }, fetcher: octocat })).body
      .lock as LfsLock;
    expect(lock.owner.name).toBe("octocat");

    const writer = github("hubot", { push: true, pull: true });
    expect(
      (await call(githubEnv(), `${repo}/locks/${lock.id}/unlock`, { token: "gho_hubot", json: { force: true }, fetcher: writer })).status,
    ).toBe(403);
    const maintainer = github("maintainer", { maintain: true, push: true, pull: true });
    expect(
      (await call(githubEnv(), `${repo}/locks/${lock.id}/unlock`, { token: "gho_maint", json: { force: true }, fetcher: maintainer }))
        .status,
    ).toBe(200);
  });

  it("refuses to lock when GitHub cannot say who the token belongs to", async () => {
    const res = await call(githubEnv(), `${freshRepo()}/locks`, { token: "gho_app", json: { path: "a.blend" }, fetcher: anonymousApp });
    expect(res.status).toBe(403);
  });
});
