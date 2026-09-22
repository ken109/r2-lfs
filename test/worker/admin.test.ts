import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { audited, auditLog } from "../../src/app/admin-audit.ts";
import { changeRefusal } from "../../src/app/admin.ts";
import type { AuditEntry, AuditLog } from "../../src/app/ports.ts";
import { emailMatches, mayChange } from "../../src/domain/access.ts";
import { parseConfig } from "../../src/domain/config.ts";
import type { Env } from "../../src/env.ts";
import { gateAdmin } from "../../src/http/admin-gate.ts";
import type { Fetcher } from "../../src/infra/host-permissions.ts";
import { clearJwtKeysCache } from "../../src/infra/jwt.ts";
import { AUDIT_PREFIX, R2AuditLog } from "../../src/infra/r2-audit-log.ts";
import { signingKey } from "./jwt-helpers.ts";

const TEAM = "my-team.cloudflareaccess.com";
const AUD = "aud-tag-0123456789";

function certs(...keys: JsonWebKey[]) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (input) => {
    calls.push(String(input));
    return Response.json({ keys });
  };
  return { calls, fetcher };
}

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  BUCKET: env.BUCKET,
  LOCKS: env.LOCKS,
  ALLOWED_REPOS: "acme/*",
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  ...overrides,
});

const now = () => Math.floor(Date.now() / 1000);
const claims = (over: Record<string, unknown> = {}) => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  exp: now() + 600,
  email: "me@example.com",
  ...over,
});

/** The response that stops the request, or undefined when it goes on to the UI. */
async function gate(e: Env, fetcher: Fetcher, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Cf-Access-Jwt-Assertion", token);
  const result = await gateAdmin(new Request("https://lfs.example.com/_admin", { ...init, headers }), e, { fetch: fetcher });
  return result.ok ? undefined : result.response;
}

beforeEach(() => clearJwtKeysCache());

describe("admin gate", () => {
  it("keeps the admin UI closed until Cloudflare Access is configured", async () => {
    const res = await gate(makeEnv({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }), certs().fetcher);
    expect(res?.status).toBe(404);
    expect(await res?.text()).toContain("ACCESS_TEAM_DOMAIN");
    const half = await gate(makeEnv({ ACCESS_AUD: "" }), certs().fetcher);
    expect(half?.status).toBe(500);
  });

  it("lets through a valid Access token for this application only", async () => {
    const key = await signingKey("k1");
    const { calls, fetcher } = certs(key.jwk);
    expect(await gate(makeEnv(), fetcher, await key.sign(claims()))).toBeUndefined();
    expect(calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);

    for (const token of [
      await key.sign(claims({ aud: ["another-app"] })),
      await key.sign(claims({ iss: "https://other-team.cloudflareaccess.com" })),
      await key.sign(claims({ exp: now() - 3600 })),
      await key.sign(claims({ nbf: now() + 3600 })),
      await key.sign(claims(), { alg: "none" }),
      "not-a-jwt",
    ]) {
      expect((await gate(makeEnv(), fetcher, token))?.status).toBe(403);
    }
    expect((await gate(makeEnv(), fetcher))?.status).toBe(403);
  });

  it("passes on who signed in, and accepts changes only from the admin UI's own origin", async () => {
    const key = await signingKey("k1");
    const { fetcher } = certs(key.jwk);
    const token = await key.sign(claims());
    const result = await gateAdmin(
      new Request("https://lfs.example.com/_admin", { headers: { "Cf-Access-Jwt-Assertion": token } }),
      makeEnv(),
      {
        fetch: fetcher,
      },
    );
    expect(result).toMatchObject({ ok: true, email: "me@example.com", config: { access: { aud: AUD } } });

    const post = (origin?: string) => gate(makeEnv(), fetcher, token, { method: "POST", headers: origin ? { Origin: origin } : {} });
    expect(await post("https://lfs.example.com")).toBeUndefined();
    expect((await post("https://evil.example"))?.status).toBe(403);
    expect((await post())?.status).toBe(403);
  });

  it("refuses tokens signed with another key and fetches the keys again when an unknown key id appears", async () => {
    const trusted = await signingKey("k1");
    const forged = await signingKey("k1");
    const rotated = await signingKey("k2");
    let published = [trusted.jwk];
    const calls: string[] = [];
    const fetcher: Fetcher = async (input) => {
      calls.push(String(input));
      return Response.json({ keys: published });
    };

    expect((await gate(makeEnv(), fetcher, await forged.sign(claims())))?.status).toBe(403);
    published = [trusted.jwk, rotated.jwk];
    expect(await gate(makeEnv(), fetcher, await rotated.sign(claims()))).toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});

const config = (ADMIN_EMAILS?: string) =>
  parseConfig({ ALLOWED_REPOS: "acme/*", AUTH_MODE: "token", ...(ADMIN_EMAILS === undefined ? {} : { ADMIN_EMAILS }) });

describe("admin permissions", () => {
  it("lets everyone change things without ADMIN_EMAILS, and only those it lists with it", () => {
    expect(config().adminEmails).toBeUndefined();
    expect(config("  ").adminEmails).toBeUndefined();
    expect(mayChange(config(), "anyone@example.com")).toBe(true);
    expect(changeRefusal(config(), "anyone@example.com")).toBeUndefined();

    const limited = config("Me@Example.com, *@team.example");
    expect(limited.adminEmails).toEqual(["me@example.com", "*@team.example"]);
    expect(mayChange(limited, "me@example.com")).toBe(true);
    expect(mayChange(limited, "someone@TEAM.example")).toBe(true);
    expect(mayChange(limited, "someone@team.example.evil")).toBe(false);
    expect(mayChange(limited, "you@example.com")).toBe(false);
    expect(changeRefusal(limited, "you@example.com")).toContain("ADMIN_EMAILS");
  });

  it("matches * as any characters and nothing else as a pattern", () => {
    expect(emailMatches("*", "a@b.c")).toBe(true);
    expect(emailMatches("a.b@c.d", "axb@c.d")).toBe(false);
    expect(emailMatches("*+ci@c.d", "me+ci@c.d")).toBe(true);
  });

  it("warns about entries that are not emails and never opens up because of them", () => {
    const typo = config("admins");
    expect(typo.warnings).toEqual([expect.stringContaining('"admins"')]);
    expect(mayChange(typo, "admins")).toBe(true);
    expect(mayChange(typo, "me@example.com")).toBe(false);
    expect(mayChange(config(","), "me@example.com")).toBe(false);
  });
});

/** An audit log in memory, newest first. */
function memoryLog(): AuditLog & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record: async (entry) => {
      entries.unshift(entry);
    },
    list: async () => ({ entries }),
  };
}

const fixedNow = () => new Date("2026-09-14T00:00:00Z");

describe("admin audit log", () => {
  it("records changes that were made, failed or refused", async () => {
    const log = memoryLog();
    const deps = { log, email: "me@example.com", refusal: undefined, now: fixedNow };
    expect(
      await audited(deps, { action: "token.revoke", target: "abc", detail: (v: string) => v }, async () => ({ ok: true, value: "ci" })),
    ).toEqual({
      ok: true,
      value: "ci",
    });
    await audited(deps, { action: "token.revoke", target: "zzz" }, async () => ({ ok: false, status: 404, message: "No token" }));
    let ran = false;
    const refused = await audited({ ...deps, refusal: "look only" }, { action: "lock.unlock", target: "acme/game" }, async () => {
      ran = true;
      return { ok: true, value: 1 };
    });
    expect(refused).toEqual({ ok: false, status: 403, message: "look only" });
    expect(ran).toBe(false);
    await expect(
      audited(deps, { action: "objects.trash", target: "acme/game" }, async () => Promise.reject(new Error("R2 is down"))),
    ).rejects.toThrow("R2 is down");

    expect(log.entries.map((e) => [e.action, e.outcome, e.detail])).toEqual([
      ["objects.trash", "failed", "R2 is down"],
      ["lock.unlock", "refused", "look only"],
      ["token.revoke", "failed", "404 No token"],
      ["token.revoke", "done", "ci"],
    ]);
    expect(log.entries[3]).toEqual({
      at: "2026-09-14T00:00:00.000Z",
      email: "me@example.com",
      action: "token.revoke",
      target: "abc",
      outcome: "done",
      detail: "ci",
    });
  });

  it("keeps the change when the record cannot be written", async () => {
    const broken: AuditLog = { record: async () => Promise.reject(new Error("full")), list: async () => ({ entries: [] }) };
    expect(
      await audited({ log: broken, email: "a@b.c", refusal: undefined, now: fixedNow }, { action: "x", target: "y" }, async () => ({
        ok: true,
        value: 1,
      })),
    ).toEqual({
      ok: true,
      value: 1,
    });
  });

  it("lists the entries it keeps in R2 newest first, a page at a time", async () => {
    const log = new R2AuditLog(env.BUCKET);
    for (const [i, at] of ["2026-09-14T00:00:00Z", "2026-09-16T00:00:00Z", "2026-09-15T00:00:00Z"].entries()) {
      await log.record({
        at: new Date(at).toISOString(),
        email: "me@example.com",
        action: "token.create",
        target: `t${i}`,
        outcome: "done",
      });
    }
    const first = await log.list(undefined, 2);
    expect(first.entries.map((e) => e.target)).toEqual(["t1", "t2"]);
    expect(first.cursor).toBeDefined();
    const second = await log.list(first.cursor, 2);
    expect(second.entries.map((e) => e.target)).toEqual(["t0"]);
    expect((await env.BUCKET.list({ prefix: AUDIT_PREFIX })).objects).toHaveLength(3);

    expect(await auditLog(log, "")).toMatchObject({ ok: true, value: { entries: [{ target: "t1" }, { target: "t2" }, { target: "t0" }] } });
    const failing: AuditLog = { record: async () => {}, list: async () => Promise.reject(new Error("down")) };
    expect(await auditLog(failing, undefined)).toMatchObject({ ok: false, status: 502 });
  });
});
