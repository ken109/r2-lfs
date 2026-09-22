import type { Grant, Permission } from "../domain/access.ts";
import type { AccessSettings } from "../domain/config.ts";
import type { Repo } from "../domain/repo.ts";
import type { GrantedPermission, LfsAction, LfsLock, TokensFile } from "../shared/contract.ts";

/** Where LFS objects live. */
export interface ObjectStore {
  head(key: string): Promise<{ size: number } | null>;
  /** `size` is always the whole object's, even when only `range` is read. */
  get(key: string, range?: { offset: number; length: number }): Promise<{ body: ReadableStream; size: number } | null>;
  /** Stores `body` only if it hashes to `sha256`. */
  put(key: string, body: ReadableStream, sha256: string): Promise<"stored" | "checksum-mismatch">;
  /** The hex SHA-256 of a stored object, read in full; undefined when it does not exist. */
  sha256(key: string): Promise<string | undefined>;
  /** Writes an empty object, such as a membership marker. */
  mark(key: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Total bytes stored under `prefix`; may be up to a minute old. */
  usage(prefix: string): Promise<number>;
}

/** One request to the LFS API, for Workers Analytics Engine. */
export interface MetricPoint {
  repo: string;
  endpoint: string;
  method: string;
  status: number;
  bytes: number;
}

export interface Metrics {
  record(point: MetricPoint): void;
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
  verify(oid: string): Promise<Action>;
  /** Where `r2-lfs transfer-agent` starts a multipart upload; always through the Worker. */
  multipart(oid: string): Promise<Action>;
}

/** Multipart uploads in the bucket, and moving a finished one into place. */
export interface MultipartStore {
  create(key: string): Promise<string>;
  /** Undefined when no upload with that id exists for `key`. */
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream,
  ): Promise<{ partNumber: number; etag: string } | undefined>;
  complete(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  /**
   * Copies `source` to `target` if its content hashes to `sha256`, checking while it copies, so a mismatch
   * leaves `target` untouched.
   */
  promote(source: string, target: string, sha256: string, size: number): Promise<"stored" | "checksum-mismatch">;
}

/** Grants whose secret equals the presented token. */
export interface TokenDirectory {
  grantsFor(token: string): Promise<Grant[]>;
}

export type Lookup =
  | {
      ok: true;
      permission: Permission;
      /** The host's immutable id of the repository, when its API reports one. */
      repositoryId?: string;
    }
  | { ok: false; status: 401 | 403 | 404 | 502 | 503; message: string };

/** What the request may do, and a way to learn who is asking, which only file locks need. */
export type Authorization =
  | {
      ok: true;
      permission: Permission;
      identify: () => Promise<string | undefined>;
      /** Set for a token a batch response issued for one object's transfer, which covers nothing else. */
      oid?: string;
    }
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
  /** GitHub's immutable id of that repository. */
  repositoryId: string | undefined;
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

/** What a client sent as HTTP Basic credentials; `username` is absent for a bearer token. */
export interface Credentials {
  username?: string;
  password: string;
}

/** The bucket as gc through the server needs it: list, copy with a hash check, and delete. */
export interface RepositoryStorage {
  list(
    prefix: string,
    cursor?: string,
  ): Promise<{ objects: { key: string; size: number; uploaded: Date; storageClass: string }[]; cursor?: string }>;
  head(key: string): Promise<{ size: number; storageClass: string } | null>;
  /** Copies only content that hashes to `sha256`; `locked` when a bucket lock rule refuses to overwrite the target. */
  copy(
    source: string,
    target: string,
    opts: { sha256: string; storageClass?: "Standard" | "InfrequentAccess" },
  ): Promise<"copied" | "missing" | "checksum-mismatch" | "locked">;
  /** `locked` when a bucket lock rule still protects the object. */
  delete(key: string): Promise<"deleted" | "locked">;
}

/** What a token the Worker issued stands for. */
export interface SessionClaims {
  /** `owner/repo`, lowercased. */
  repo: string;
  permission: GrantedPermission;
  /** Unix seconds. */
  expires: number;
  /** Who holds it, as file locks name them. */
  login?: string;
  /** Limits the token to transferring this object. */
  oid?: string;
}

/** Short-lived tokens the Worker signs, so clients and transfer actions do not carry a Git host's token around. */
export interface SessionTokens {
  mint(claims: SessionClaims): Promise<string>;
  /** The claims of a token this server signed and that has not expired; undefined otherwise. */
  verify(token: string): Promise<SessionClaims | undefined>;
}

/** Which repository each name belongs to, recorded the first time the name is used. */
export interface RepositoryIdentities {
  /** Records `id` for the name if none is recorded; false when a different repository already holds the name. */
  claim(repo: Repo, id: string): Promise<boolean>;
}

/** The Git host whose repository permissions the server mirrors. */
export interface HostPermissions {
  lookup(repo: Repo, credentials: Credentials): Promise<Lookup>;
  /** The user name of the account the credentials belong to. */
  login(credentials: Credentials): Promise<string | undefined>;
}

/** The tokens file in the bucket, written only if nobody changed it since it was read. */
export interface TokensFileStore {
  /** `etag` is null when the file does not exist yet; `value` is the parsed JSON, or undefined if it is not JSON. */
  read(): Promise<{ value: unknown; etag: string | null }>;
  /** False when the file changed since `etag`, or was created when `etag` is null. */
  write(file: TokensFile, etag: string | null): Promise<boolean>;
}

/** Makes a new token: its secret, a short id and the hash that is stored instead of the secret. */
export interface TokenMinter {
  mint(): Promise<{ token: string; id: string; sha256: string }>;
}

/** One page of a bucket listing, in key order. */
export interface BucketLister {
  list(cursor: string | undefined): Promise<{ objects: { key: string; size: number }[]; cursor?: string }>;
}

/** Requests the Worker recorded in Workers Analytics Engine, by repository. */
export interface ActivitySource {
  /** With `repo` (lowercased owner/name), that repository alone. */
  byRepository(hours: number, repo?: string): Promise<{ repo: string; requests: number; bytes: number; errors: number }[]>;
}
