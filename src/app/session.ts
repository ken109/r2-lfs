import type { Permission } from "../domain/access.ts";
import type { Repo } from "../domain/repo.ts";
import { ACTION_TTL_SECONDS, SESSION_TOKEN_PREFIX, SESSION_TTL_SECONDS, type SessionResponse } from "../shared/contract.ts";
import type { Result } from "./lfs.ts";
import type { Credentials, SessionTokens } from "./ports.ts";

export interface SessionContext {
  repo: Repo;
  permission: Permission;
  identify: () => Promise<string | undefined>;
  sessions: SessionTokens;
  /** Milliseconds since the epoch; tests fix it. */
  now?: () => number;
}

const repoKey = (repo: Repo) => `${repo.owner}/${repo.name}`.toLowerCase();
const nowSeconds = (ctx: { now?: () => number }) => Math.floor((ctx.now ?? Date.now)() / 1000);

/** What a request is for, as far as a transfer action's token cares. */
export type TransferScope = { kind: "verify" } | { kind: "transfer"; oid: string } | { kind: "other" };

/** A transfer action's token (`tokenOid`) covers that object's transfer and the verify call after it, and nothing else. */
export function checkTransferScope(tokenOid: string | undefined, scope: TransferScope): Result<void> {
  if (tokenOid === undefined || scope.kind === "verify" || (scope.kind === "transfer" && scope.oid === tokenOid)) {
    return { ok: true, value: undefined };
  }
  return { ok: false, status: 403, message: "This token was issued for one object's transfer only" };
}

/** Makes the Authorization header of a transfer action: a short-lived token for that object's transfer alone. */
export function actionAuthorization(ctx: Pick<SessionContext, "repo" | "sessions" | "now">) {
  return async (oid: string, permission: "read" | "write"): Promise<string> =>
    `Bearer ${await ctx.sessions.mint({ repo: repoKey(ctx.repo), permission, oid, expires: nowSeconds(ctx) + ACTION_TTL_SECONDS })}`;
}

/** POST <repository>/r2-lfs/session: trades Git host credentials for a short-lived token with the same permission. */
export async function openSession(ctx: SessionContext, presented: Credentials | undefined): Promise<Result<SessionResponse>> {
  // Trading a token for another would let a session outlive the permission it was issued for.
  if (presented?.password.startsWith(SESSION_TOKEN_PREFIX)) {
    return { ok: false, status: 403, message: "Send Git host credentials, not an r2-lfs token" };
  }
  const { permission } = ctx;
  if (permission === "none") return { ok: false, status: 403, message: "You do not have read access to this repository" };
  const expires = nowSeconds(ctx) + SESSION_TTL_SECONDS;
  const login = await ctx.identify();
  const token = await ctx.sessions.mint({ repo: repoKey(ctx.repo), permission, expires, ...(login ? { login } : {}) });
  return { ok: true, value: { token, expires_at: new Date(expires * 1000).toISOString(), permission } };
}
