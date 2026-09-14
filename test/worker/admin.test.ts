import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Env } from "../../src/env.ts";
import { gateAdmin } from "../../src/http/admin-gate.ts";
import type { Fetcher } from "../../src/infra/github-permissions.ts";
import { clearJwtKeysCache } from "../../src/infra/jwt.ts";
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

async function gate(e: Env, fetcher: Fetcher, token?: string) {
  const headers = token ? { "Cf-Access-Jwt-Assertion": token } : undefined;
  return gateAdmin(new Request("https://lfs.example.com/_admin", { headers }), e, { fetch: fetcher });
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
