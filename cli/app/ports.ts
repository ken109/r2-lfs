// Interfaces the use cases depend on. Implementations live in ../infra; tests supply fakes.

import type { BatchObjectResult, LfsAction, MultipartStart, ServerInfo } from "../../src/shared/contract.ts";
import type { PointerChange } from "../domain/history.ts";
import type { ObjectRef, StoredObject } from "../domain/objects.ts";
import type { Pointer } from "../domain/pointer.ts";
import type { LfsLocation } from "../domain/remote.ts";
import type { TarEntry } from "../domain/tar.ts";

export interface Progress {
  advance(count?: number, message?: string): void;
  stop(message?: string): void;
}

/** How use cases tell the user what is happening, without knowing how it is shown. */
export interface Reporter {
  step(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  task<T>(label: string, work: () => T | Promise<T>, done?: (result: T) => string): Promise<T>;
  progress(total: number, label: string): Progress;
}

export interface PointerAt extends Pointer {
  paths: Set<string>;
}

export interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  size: number;
  path: string;
}

export interface GitRepository {
  readonly dir: string;
  config(key: string, file?: string): string | undefined;
  /** `lfs.url` the way git-lfs resolves it: git config first, then the committed .lfsconfig. */
  lfsUrl(): string | undefined;
  remoteUrl(remote?: string): string | undefined;
  isClean(): boolean;
  /** Commits at the tip of every branch, remote-tracking branch and tag. */
  refTips(): string[];
  resolveCommit(rev: string): string;
  hasTag(tag: string): boolean;
  /** Commits on any ref with a committer date at or after `sinceUnix`. */
  commitsSince(sinceUnix: number): { sha: string; time: number }[];
  /** Every time an LFS pointer was added or changed, across all refs. */
  pointerHistory(): PointerChange[];
  /** Every LFS object in the trees of `commits`, with the paths it appears at. */
  pointersIn(commits: Iterable<string>): Map<string, PointerAt>;
  resolvePointers(blobs: Iterable<string>): Map<string, Pointer>;
  treeEntries(commit: string): TreeEntry[];
  readBlob(object: string): Uint8Array;
  readFile(relativePath: string): string | undefined;
  /** Fetches every branch and tag of every remote; false if that failed. */
  fetchAll(): boolean;
  /** Reasons the local history may lack commits the remote has, such as a shallow or single-branch clone. */
  historyGaps(): string[];
  setLfsConfig(key: string, value: string): void;
  lfsTrack(patterns: string[], opts?: { lockable?: boolean }): void;
  lfsInstalled(): boolean;
  lfsHooksInstalled(): boolean;
  lfsObjectPath(oid: string): string;
  /** Long-running git-lfs operations attached to the terminal. Resolve to the exit code. */
  lfsFetch(remote: string, refs: string[], opts?: { all?: boolean; url?: string }): Promise<number>;
  /** Pushes the objects of every commit reachable from any ref, remote-tracking branches included. */
  lfsPushAll(remote: string): Promise<number>;
  lfsMigrateImport(patterns: string[]): Promise<number>;
  commitFiles(paths: string[], message: string): boolean;
}

/** User-level git configuration and credential helpers. */
export interface GlobalGitConfig {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  helpersFor(origin: string): string[];
  useGhCredentials(origin: string): void;
  /** Makes `helper` the only credential helper for `origin`. */
  useCredentialHelper(origin: string, helper: string): void;
  /** The password git's credential helpers would send to `origin`, without prompting. */
  credentialFor(origin: string): string | undefined;
}

/** OpenID Connect tokens of the GitHub Actions job this process runs in. */
export interface ActionsIdTokens {
  /** Whether the job has `id-token: write`. */
  available(): boolean;
  request(audience: string): Promise<string | undefined>;
}

export interface GitHubCli {
  available(): boolean;
  loggedIn(): boolean;
  /** `gh auth token`, or undefined when gh is missing or logged out. */
  token(): string | undefined;
  /** `undefined` when the release does not exist. */
  releaseState(repo: string | undefined, tag: string): "draft" | "published" | undefined;
  createDraftRelease(repo: string | undefined, tag: string, title: string, notes: string): void;
  uploadAssets(repo: string | undefined, tag: string, files: string[]): Promise<number>;
  publishRelease(repo: string | undefined, tag: string): void;
}

export interface BucketObject {
  text(): Promise<string>;
  etag: string | null;
}

export interface WriteResult {
  ok: boolean;
  status: number;
  message: string;
  /** Refused by a bucket lock rule, which proves nothing changed. */
  locked?: boolean;
}

export interface Bucket {
  readonly name: string;
  /** Whether copies send the SSE-C key that an encrypting server stores objects with. */
  readonly encrypted: boolean;
  list(prefix: string): Promise<StoredObject[]>;
  get(key: string): Promise<BucketObject | undefined>;
  /**
   * `expectEtag: null` writes only if the key does not exist; a string, only if it still has that ETag.
   * Throws `ConflictError` when that condition fails.
   */
  put(key: string, body: string, opts?: { expectEtag?: string | null }): Promise<void>;
  /** Throws when the bucket cannot say. */
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<WriteResult>;
  copy(source: string, target: string, storageClass?: "STANDARD" | "STANDARD_IA"): Promise<WriteResult>;
}

export type BatchObject = BatchObjectResult;

export type InfoResult =
  | { kind: "ok"; info: ServerInfo }
  | { kind: "misconfigured"; problems: string[] }
  | { kind: "not-r2-lfs"; status: number };

export interface Session {
  token: string;
  expiresAt: Date;
}

/** Short-lived tokens from servers' session endpoints, kept between git's calls to the credential helper. */
export interface SessionCache {
  get(location: LfsLocation): Session | undefined;
  set(location: LfsLocation, session: Session): void;
  delete(location: LfsLocation): void;
}

export interface LfsClient {
  readonly location: LfsLocation;
  readonly hasCredentials: boolean;
  info(): Promise<InfoResult>;
  /** Trades this client's credentials for a short-lived token for the repository; undefined when the server will not. */
  session(): Promise<Session | undefined>;
  /** Throws `BatchRequestError` when the whole request is refused. */
  batch(operation: "upload" | "download", objects: ObjectRef[]): Promise<BatchObject[]>;
  download(object: BatchObject): Promise<AsyncIterable<Uint8Array>>;
}

export class BatchRequestError extends Error {
  override readonly name = "BatchRequestError";
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A conditional write lost to a concurrent change; running the command again resolves it. */
export class ConflictError extends Error {
  override readonly name = "ConflictError";
}

/** Local files the use cases write or inspect. */
export interface Files {
  sizeOf(path: string): number | undefined;
  /** The file's text, or undefined when it cannot be read. */
  readText(path: string): string | undefined;
  /** Writes a file others may read and everyone may run. */
  writeExecutable(path: string, text: string): void;
  mkdirp(path: string): void;
  writeText(path: string, text: string): void;
  copyFile(from: string, to: string): void;
  /** Copies a directory and everything in it. */
  copyDir(from: string, to: string): void;
  sha256(path: string): Promise<string>;
  writeTar(path: string, entries: readonly TarEntry[], onEntry?: (entry: TarEntry) => void): Promise<void>;
  /** A fresh directory under the system temp dir. */
  tempDir(prefix: string): string;
}

export interface WranglerLogin {
  email: string;
  /** The account Wrangler deploys to: CLOUDFLARE_ACCOUNT_ID, or the only account the login can use. */
  accountId: string | undefined;
}

export interface Wrangler {
  run(args: string[], opts?: { input?: string; cwd?: string }): { code: number; output: string };
  /** Undefined when Wrangler is not logged in. */
  whoami(): WranglerLogin | undefined;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** A failed request to the server; `status` is undefined when it never answered. */
export class TransferError extends Error {
  readonly status: number | undefined;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.name = "TransferError";
    this.status = status;
  }
}

/** The Worker's multipart endpoints, addressed through the action a batch response hands out. */
export interface MultipartUploads {
  start(action: LfsAction, size: number): Promise<MultipartStart>;
  /** Undefined when the upload no longer exists, so it has to start over. */
  uploadPart(action: LfsAction, uploadId: string, partNumber: number, data: Uint8Array): Promise<UploadedPart | undefined>;
  complete(action: LfsAction, uploadId: string, size: number, parts: UploadedPart[]): Promise<void>;
}

/** Where an interrupted upload is remembered, so the next push continues it. */
export interface SavedUpload {
  href: string;
  size: number;
  uploadId: string;
  partSize: number;
  parts: UploadedPart[];
}

export interface UploadStates {
  load(oid: string): SavedUpload | undefined;
  save(oid: string, state: SavedUpload): void;
  remove(oid: string): void;
}
