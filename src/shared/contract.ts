// Contracts shared by the Worker and the CLI. Keep this file free of runtime-specific APIs.

export const VERSION = "0.1.0"; // x-release-please-version

/** Must match `compatibility_date` in wrangler.jsonc; `r2-lfs setup` deploys with it. */
export const WORKER_COMPATIBILITY_DATE = "2026-08-22";

/** Objects of every repository in `shared` layout. GitHub logins never start with `_`. */
export const SHARED_PREFIX = "_shared/";
/** `r2-lfs gc` moves objects here; a lifecycle rule expires them. */
export const TRASH_PREFIX = "_trash/";
/** Tokens managed by `r2-lfs token`. */
export const TOKENS_KEY = "_meta/tokens.json";

export const INFO_PATH = "/_r2-lfs/info";

export type StorageLayout = "per-repo" | "shared";

export interface ServerInfo {
  name: "r2-lfs";
  version: string;
  authMode: "github" | "token";
  storageLayout: StorageLayout;
  transfer: "presigned" | "proxy";
  proxyMaxUploadBytes: number;
}

export interface StoredToken {
  id: string;
  label: string;
  /** `owner/repo`, `owner/*` or `*`, lowercased. */
  scope: string;
  permission: "read" | "write";
  /** Hex SHA-256 of the token; the token itself is never stored. */
  sha256: string;
  created: string;
}

export interface TokensFile {
  version: 1;
  tokens: StoredToken[];
}

export const OID_PATTERN = /^[0-9a-f]{64}$/;

/** GitHub names are case-insensitive, so keys are lowercased to keep one prefix per repository. */
export function repoPrefix(layout: StorageLayout, owner: string, repo: string): string {
  return layout === "shared" ? SHARED_PREFIX : `${owner.toLowerCase()}/${repo.toLowerCase()}/`;
}

export function scopeCovers(scope: string, owner: string, repo: string): boolean {
  const o = owner.toLowerCase();
  return scope === "*" || scope === `${o}/*` || scope === `${o}/${repo.toLowerCase()}`;
}
