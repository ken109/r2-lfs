// Contracts shared by the Worker and the CLI. Keep this file to APIs both runtimes have, such as Web Crypto.

export const VERSION = "0.4.0"; // x-release-please-version

/** Must match `compatibility_date` in wrangler.jsonc; `r2-lfs setup` deploys with it. */
export const WORKER_COMPATIBILITY_DATE = "2026-08-22";

/** Objects of every repository in `shared` layout. GitHub logins never start with `_`. */
export const SHARED_PREFIX = "_shared/";
/** Presigned uploads land here until the Worker has checked their hash; a lifecycle rule clears leftovers. */
export const INCOMING_PREFIX = "_incoming/";
/** In the shared layout, `_members/<owner>/<repo>/<oid>` records that the repository uploaded the object. */
export const MEMBERS_PREFIX = "_members/";
/** `r2-lfs gc` moves objects here; a lifecycle rule expires them. */
export const TRASH_PREFIX = "_trash/";
/**
 * `_repos/<owner>/<repo>` holds the Git host's id of the repository that first used the name, so a new repository that
 * reuses the name of a deleted, renamed or transferred one cannot reach its objects.
 */
export const REPOS_PREFIX = "_repos/";
/** The key the Worker signs its short-lived tokens with; deleting it revokes them all within minutes. */
export const SESSION_KEY_KEY = "_meta/session-key";
/** Tokens the Worker signs start with this, unlike tokens from `r2-lfs token` (`r2lfs_`) and JWTs. */
export const SESSION_TOKEN_PREFIX = "r2lfs-s1.";
/** How long a token from the session endpoint lasts. */
export const SESSION_TTL_SECONDS = 3600;
/** How long a transfer action's token lasts: long enough to finish a large, resumed upload. */
export const ACTION_TTL_SECONDS = 12 * 3600;
/** Tokens managed by `r2-lfs token`. */
export const TOKENS_KEY = "_meta/tokens.json";

/** The Workers Analytics Engine dataset request metrics go to; setup's Worker config binds it. */
export const METRICS_DATASET = "r2_lfs";

export const INFO_PATH = "/_r2-lfs/info";
/** The admin UI. GitHub logins never start with `_`, so no repository path can collide with it. */
export const ADMIN_PATH = "/_admin";

export type StorageLayout = "per-repo" | "shared";
/** How the server authenticates: by mirroring a Git host's permissions, or with its own tokens. */
export type AuthMode = "github" | "gitlab" | "gitea" | "bitbucket" | "token";

/** What `INFO_PATH` answers with status 200. */
export interface ServerInfo {
  name: "r2-lfs";
  version: string;
  authMode: AuthMode;
  /** The web origin of the Git host whose permissions are mirrored; absent in token mode. */
  authHost?: string;
  storageLayout: StorageLayout;
  transfer: "presigned" | "proxy";
  proxyMaxUploadBytes: number;
  /** Settings that work but should change, such as deprecated variables. */
  warnings?: string[];
  /** Set when objects are stored with SSE-C, which copies through R2's S3 API need the key for. */
  encrypted?: boolean;
  /** Set when GitHub Actions workflows may authenticate with an OIDC token requested for this audience. */
  actionsOidcAudience?: string;
  /** Set when `<repository>/r2-lfs/session` trades a Git host token for a short-lived one. */
  sessions?: boolean;
  /** Set when `<repository>/r2-lfs/objects` lists and changes objects, which the per-repo layout allows. */
  storage?: boolean;
}

/** Appended to a repository's LFS URL: POST with Git host credentials for a short-lived token. */
export const SESSION_ENDPOINT = "r2-lfs/session";

/**
 * Appended to a repository's LFS URL: GET lists its objects (`?in=live|trash`, `&cursor=`), POST `/trash`, `/restore` or
 * `/tier` with `{ oids }` changes them. This lets gc and restore run without R2 API credentials, per-repo layout only.
 */
export const STORAGE_ENDPOINT = "r2-lfs/objects";
/** Objects one change request may name, so a request stays within a Worker's subrequest limit. */
export const MAX_STORAGE_CHANGES = 10;

export type StorageAction = "trash" | "restore" | "tier";

/** One page of `GET <repository>/r2-lfs/objects`. */
export interface StorageListing {
  objects: { oid: string; size: number; uploaded: string; storage_class: "STANDARD" | "STANDARD_IA" }[];
  cursor?: string;
}

/** What `POST <repository>/r2-lfs/objects/<action>` did to each object. */
export interface StorageChanges {
  results: {
    oid: string;
    /** `locked`: a bucket lock rule still protects the object; `missing`: there was nothing to act on. */
    outcome: "trashed" | "restored" | "tiered" | "locked" | "missing" | "failed";
    message?: string;
  }[];
}

/** What a token or a session may do in a repository. `admin` can also unlock other people's file locks. */
export type GrantedPermission = "read" | "write" | "admin";

export function isGrantedPermission(value: unknown): value is GrantedPermission {
  return value === "read" || value === "write" || value === "admin";
}

/** What the session endpoint answers with status 200. */
export interface SessionResponse {
  token: string;
  /** ISO 8601. */
  expires_at: string;
  permission: GrantedPermission;
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
  transfer: "basic" | typeof MULTIPART_TRANSFER;
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
  permission: GrantedPermission;
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
      isGrantedPermission(t.permission),
  );
  return valid ? file.tokens : undefined;
}

/** A tokens file before the first token. */
export function emptyTokensFile(): TokensFile {
  return { version: 1, tokens: [] };
}

/** Reads the tokens file as stored; `undefined`, for no file yet, reads as an empty one. */
export function readTokensFile(text: string | undefined): { ok: true; file: TokensFile } | { ok: false; problem: "not-json" | "format" } {
  if (text === undefined) return { ok: true, file: emptyTokensFile() };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: "not-json" };
  }
  const tokens = storedTokensIn(value);
  return tokens ? { ok: true, file: { version: 1, tokens } } : { ok: false, problem: "format" };
}

/** How the tokens file is stored: indented JSON, ending in a newline. */
export function serializeTokensFile(file: TokensFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A new token: `r2lfs_` and 32 random bytes, a short id to name it by, and the hex SHA-256 that is stored instead. */
export async function mintToken(): Promise<{ token: string; id: string; sha256: string }> {
  const token = `r2lfs_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const id = hex(crypto.getRandomValues(new Uint8Array(4)));
  const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
  return { token, id, sha256 };
}

export interface NewStoredToken {
  label: string;
  scope: string;
  permission: StoredToken["permission"];
  id: string;
  sha256: string;
  created: Date;
}

/** An edit of the tokens file, which the CLI and the admin UI both make. */
export type TokenEdit = { ok: true; file: TokensFile; entry: StoredToken } | { ok: false; message: string };

export function addStoredToken(file: TokensFile, input: NewStoredToken): TokenEdit {
  if (!REPO_PATTERN.test(input.scope)) {
    return { ok: false, message: "scope must be owner/repo, with * allowed within names (my-org/*, me/blender-*), or *" };
  }
  if (!input.label.trim()) return { ok: false, message: "label must not be empty" };
  if (file.tokens.some((t) => t.label === input.label)) return { ok: false, message: `a token labelled ${input.label} already exists` };
  const entry: StoredToken = {
    id: input.id,
    label: input.label,
    scope: input.scope.toLowerCase(),
    permission: input.permission,
    sha256: input.sha256,
    created: input.created.toISOString(),
  };
  return { ok: true, file: { ...file, tokens: [...file.tokens, entry] }, entry };
}

export function revokeStoredToken(file: TokensFile, idOrLabel: string): TokenEdit {
  const entry = file.tokens.find((t) => t.id === idOrLabel || t.label === idOrLabel);
  if (!entry) return { ok: false, message: `no token with id or label ${idOrLabel}` };
  return { ok: true, file: { ...file, tokens: file.tokens.filter((t) => t !== entry) }, entry };
}

/** An LFS object id, a hex SHA-256, as a regular expression source. */
export const LFS_OID = "[0-9a-f]{64}";
export const OID_PATTERN = new RegExp(`^${LFS_OID}$`);

/** The custom transfer `r2-lfs transfer-agent` implements: resumable multipart uploads through the Worker. */
export const MULTIPART_TRANSFER = "r2-lfs-multipart";
/** R2's smallest part, except the last. */
export const MIN_PART_BYTES = 5 * 1024 ** 2;

/** What POST /objects/<oid>/multipart answers. */
export interface MultipartStart {
  uploadId: string;
  /** Every part but the last must have exactly this size. */
  partSize: number;
}

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

/** Where a presigned upload waits for its hash check. */
export function incomingKey(owner: string, repo: string, oid: string): string {
  return `${INCOMING_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}/${oid}`;
}

/** Where the id of the repository that owns a name is recorded. */
export function repositoryIdKey(owner: string, repo: string): string {
  return `${REPOS_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** The marker that lets a repository read a shared object. */
export function memberKey(owner: string, repo: string, oid: string): string {
  return `${MEMBERS_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}/${oid}`;
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
