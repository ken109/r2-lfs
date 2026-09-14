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
/** The admin UI. GitHub logins never start with `_`, so no repository path can collide with it. */
export const ADMIN_PATH = "/_admin";

export type StorageLayout = "per-repo" | "shared";
export type AuthMode = "github" | "token";

/** What `INFO_PATH` answers with status 200. */
export interface ServerInfo {
  name: "r2-lfs";
  version: string;
  authMode: AuthMode;
  storageLayout: StorageLayout;
  transfer: "presigned" | "proxy";
  proxyMaxUploadBytes: number;
  /** Settings that work but should change, such as deprecated variables. */
  warnings?: string[];
}

/** A transfer action in a Git LFS batch response. */
export interface LfsAction {
  href: string;
  header?: Record<string, string>;
  expires_in?: number;
}

/** One object in a Git LFS batch response: actions to take, or an error for this object alone. */
export interface BatchObjectResult {
  oid: string;
  size: number;
  authenticated?: boolean;
  actions?: Record<string, LfsAction>;
  error?: { code: number; message: string };
}

export interface BatchResponse {
  transfer: "basic";
  objects: BatchObjectResult[];
  hash_algo: "sha256";
}

/** A file lock, as the Git LFS locking API describes it. */
export interface LfsLock {
  id: string;
  path: string;
  locked_at: string;
  owner: { name: string };
}

/** What `INFO_PATH` answers with status 500 when the settings are invalid. */
export interface MisconfiguredInfo {
  name: "r2-lfs";
  version: string;
  problems: string[];
}

export interface StoredToken {
  id: string;
  label: string;
  /** A REPO_PATTERN, lowercased. */
  scope: string;
  /** `admin` can also unlock other people's file locks. */
  permission: "read" | "write" | "admin";
  /** Hex SHA-256 of the token; the token itself is never stored. */
  sha256: string;
  created: string;
}

export interface TokensFile {
  version: 1;
  tokens: StoredToken[];
}

/** The tokens of a parsed tokens file, or undefined when it does not have the expected shape. */
export function storedTokensIn(value: unknown): StoredToken[] | undefined {
  const file = value as Partial<TokensFile> | null;
  if (typeof file !== "object" || file === null || file.version !== 1 || !Array.isArray(file.tokens)) return undefined;
  const valid = file.tokens.every(
    (t: Partial<StoredToken> | null) =>
      typeof t === "object" &&
      t !== null &&
      [t.id, t.label, t.scope, t.sha256, t.created].every((field) => typeof field === "string") &&
      (t.permission === "read" || t.permission === "write" || t.permission === "admin"),
  );
  return valid ? file.tokens : undefined;
}

export const OID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A GitHub user or organization; Enterprise Managed Users end in `_shortcode`. Names never start with `_`,
 * which keeps SHARED_PREFIX, TRASH_PREFIX and TOKENS_KEY apart from every owner's prefix.
 */
export const OWNER_NAME = "[A-Za-z0-9][A-Za-z0-9_-]*";
export const REPO_NAME = "[A-Za-z0-9._-]+";
/**
 * Repositories in ALLOWED_REPOS and token scopes: `owner/repo`, where `*` stands for any characters within a
 * name, as in `my-org/*` or `me/blender-*`, or `*` alone for every repository.
 */
export const REPO_PATTERN = /^(\*|[A-Za-z0-9*][A-Za-z0-9_*-]*\/[A-Za-z0-9._*-]+)$/;

/** GitHub names are case-insensitive, so keys are lowercased to keep one prefix per repository. */
export function repoPrefix(layout: StorageLayout, owner: string, repo: string): string {
  return layout === "shared" ? SHARED_PREFIX : `${owner.toLowerCase()}/${repo.toLowerCase()}/`;
}

const patternCache = new Map<string, RegExp>();

/** Whether a REPO_PATTERN covers the repository. GitHub names are case-insensitive, and so is this. */
export function repoPatternMatches(pattern: string, owner: string, repo: string): boolean {
  if (pattern === "*") return true;
  let regex = patternCache.get(pattern);
  if (!regex) {
    const source = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
    regex = new RegExp(`^${source}$`, "i");
    patternCache.set(pattern, regex);
  }
  return regex.test(`${owner}/${repo}`);
}
