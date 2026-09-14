import type { Grant, Permission } from "../domain/access.ts";
import type { AccessSettings } from "../domain/config.ts";
import type { Repo } from "../domain/repo.ts";
import type { LfsAction, LfsLock } from "../shared/contract.ts";

/** Where LFS objects live. */
export interface ObjectStore {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
  /** Stores `body` only if it hashes to `sha256`. */
  put(key: string, body: ReadableStream, sha256: string): Promise<"stored" | "checksum-mismatch">;
  /** The hex SHA-256 of a stored object, read in full; undefined when it does not exist. */
  sha256(key: string): Promise<string | undefined>;
  /** Writes an empty object, such as a membership marker. */
  mark(key: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Copies inside the bucket without streaming the bytes through the Worker. */
export interface ObjectCopier {
  copy(source: string, target: string): Promise<void>;
}

export type Action = LfsAction;

/** How clients reach an object: presigned R2 URLs, or back through this Worker. */
export interface TransferLinks {
  readonly presigned: boolean;
  download(key: string, oid: string): Promise<Action>;
  upload(key: string, oid: string): Promise<Action>;
  verify(): Action;
}

/** Grants whose secret equals the presented token. */
export interface TokenDirectory {
  grantsFor(token: string): Promise<Grant[]>;
}

export type Lookup = { ok: true; permission: Permission } | { ok: false; status: 401 | 403 | 404 | 502 | 503; message: string };

/** What the request may do, and a way to learn who is asking, which only file locks need. */
export type Authorization =
  | { ok: true; permission: Permission; identify: () => Promise<string | undefined> }
  | { ok: false; status: 401 | 403 | 404 | 502 | 503; message: string };

/** File locks of one repository. */
export interface LockStore {
  /** Locks `path` for `owner` unless someone already holds it; the lock that stands is returned either way. */
  create(path: string, owner: string): Promise<{ created: boolean; lock: LfsLock }>;
  /** In lock order. `cursor` is the `nextCursor` of the previous page. */
  list(filter: { path?: string; id?: string; cursor?: string; limit: number }): Promise<{ locks: LfsLock[]; nextCursor?: string }>;
  find(id: string): Promise<LfsLock | undefined>;
  remove(id: string): Promise<void>;
}

export interface ActionsClaims {
  /** `owner/repo` of the workflow's repository. */
  repository: string;
  actor: string;
  workflow: string | undefined;
}

/** Checks a GitHub Actions OIDC token: signature, issuer, audience and lifetime. */
export interface ActionsTokenVerifier {
  verify(token: string, audience: string): Promise<ActionsClaims | undefined>;
}

/** Checks a Cloudflare Access token: signature, audience, issuer and lifetime. */
export interface AccessVerifier {
  /** The signed-in user's email, or undefined when the token is not valid for the application. */
  verify(token: string, settings: AccessSettings): Promise<string | undefined>;
}

export interface GithubPermissions {
  lookup(repo: Repo, token: string): Promise<Lookup>;
  /** The login of the account that owns the token. */
  login(token: string): Promise<string | undefined>;
}
