import { describe, expect, it } from "vitest";

import type { SessionClaims, SessionTokens } from "../../src/app/ports.ts";
import { actionAuthorization, checkTransferScope, openSession, type SessionContext } from "../../src/app/session.ts";
import { loadConfig, publicSettings } from "../../src/domain/config.ts";
import { ACTION_TTL_SECONDS, SESSION_TTL_SECONDS, VERSION } from "../../src/shared/contract.ts";

/** Mints tokens that spell out their claims, and remembers them. */
class RecordingSessions implements SessionTokens {
  readonly minted: SessionClaims[] = [];
  async mint(claims: SessionClaims) {
    this.minted.push(claims);
    return `r2lfs-s1.${this.minted.length}`;
  }
  async verify() {
    return undefined;
  }
}

const NOW = Date.UTC(2026, 8, 14);

function context(over: Partial<SessionContext> = {}) {
  const sessions = new RecordingSessions();
  const ctx: SessionContext = {
    repo: { owner: "Acme", name: "Assets" },
    permission: "write",
    identify: async () => "octocat",
    sessions,
    now: () => NOW,
    ...over,
  };
  return { ctx, sessions };
}

describe("sessions", () => {
  it("trades Git host credentials for a token with the same permission, for the lowercased repository", async () => {
    const { ctx, sessions } = context();
    const expires = NOW / 1000 + SESSION_TTL_SECONDS;
    expect(await openSession(ctx, { password: "gho_login" })).toEqual({
      ok: true,
      value: { token: "r2lfs-s1.1", expires_at: new Date(expires * 1000).toISOString(), permission: "write" },
    });
    expect(sessions.minted).toEqual([{ repo: "acme/assets", permission: "write", expires, login: "octocat" }]);

    const anonymous = context({ identify: async () => undefined });
    await openSession(anonymous.ctx, { password: "gho_login" });
    expect(anonymous.sessions.minted[0]).not.toHaveProperty("login");
  });

  it("refuses r2-lfs tokens and credentials without read access", async () => {
    const { ctx, sessions } = context();
    expect(await openSession(ctx, { password: "r2lfs-s1.earlier" })).toEqual({
      ok: false,
      status: 403,
      message: "Send Git host credentials, not an r2-lfs token",
    });
    expect(await openSession({ ...ctx, permission: "none" }, { password: "gho_login" })).toMatchObject({ ok: false, status: 403 });
    expect(sessions.minted).toEqual([]);
  });

  it("issues each transfer action a token for its object alone, and holds such a token to it", async () => {
    const { ctx, sessions } = context();
    expect(await actionAuthorization(ctx)("a".repeat(64), "read")).toBe("Bearer r2lfs-s1.1");
    expect(sessions.minted).toEqual([
      { repo: "acme/assets", permission: "read", oid: "a".repeat(64), expires: NOW / 1000 + ACTION_TTL_SECONDS },
    ]);

    const oid = "b".repeat(64);
    expect(checkTransferScope(undefined, { kind: "other" }).ok).toBe(true);
    expect(checkTransferScope(oid, { kind: "verify" }).ok).toBe(true);
    expect(checkTransferScope(oid, { kind: "transfer", oid }).ok).toBe(true);
    expect(checkTransferScope(oid, { kind: "transfer", oid: "c".repeat(64) })).toMatchObject({ ok: false, status: 403 });
    expect(checkTransferScope(oid, { kind: "other" })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("configuration", () => {
  it("loads the settings or lists what is wrong, and publishes only what is not secret", () => {
    const loaded = loadConfig({ ALLOWED_REPOS: "acme/*", AUTH_MODE: "token", ENCRYPTION_KEY: "0f".repeat(32) });
    if (!loaded.ok) throw loaded.error;
    expect(publicSettings(loaded.value)).toEqual({
      name: "r2-lfs",
      version: VERSION,
      authMode: "token",
      storageLayout: "per-repo",
      transfer: "proxy",
      proxyMaxUploadBytes: 100 * 1024 * 1024,
      encrypted: true,
      sessions: true,
      storage: true,
    });

    const github = loadConfig({ ALLOWED_REPOS: "acme/*", STORAGE_LAYOUT: "shared", ACTIONS_OIDC: "read" });
    if (!github.ok) throw github.error;
    expect(publicSettings(github.value)).toMatchObject({ authHost: "https://github.com", actionsOidcAudience: "r2-lfs" });
    expect(publicSettings(github.value)).not.toHaveProperty("storage");

    const broken = loadConfig({ AUTH_MODE: "nope" });
    expect(broken.ok).toBe(false);
    expect(broken.ok ? [] : broken.error.problems).toEqual([
      "ALLOWED_REPOS is required, e.g. `my-name/*,my-org/assets`",
      'AUTH_MODE must be one of github, gitlab, gitea, bitbucket, token (got "nope")',
    ]);
  });
});
