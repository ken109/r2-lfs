import type { AuthMode, GrantedPermission, LfsLock, StorageChanges, StorageLayout, StorageListing } from "../shared/contract.ts";
import type { Activity } from "./admin-activity.ts";
import type { SavedStorageReport } from "./admin-storage.ts";
import type { TokenSummary } from "./admin-tokens.ts";
import type { Result } from "./lfs.ts";
import type { AuditEntry } from "./ports.ts";

/** What the admin UI shows about the server's configuration; nothing secret. */
export interface Overview {
  email: string;
  authMode: AuthMode;
  authHost?: string;
  storageLayout: StorageLayout;
  transfer: "presigned" | "proxy";
  encrypted: boolean;
  verifyUploads: boolean;
  allowedRepos: string[];
  proxyMaxUploadBytes: number;
  maxObjectBytes?: number;
  quotaBytes?: number;
  staticTokens: number;
  actionsOidc?: { permission: GrantedPermission; audience: string };
  /** Endpoints under each repository's LFS URL besides the Git LFS API. */
  endpoints: {
    /** `r2-lfs/session`: trades Git host credentials for a short-lived token. */
    sessions: boolean;
    /** `r2-lfs/objects`: gc and restore through the Worker, in the per-repo layout only. */
    storage: boolean;
  };
  /** Whether the person signed in may change things; with ADMIN_EMAILS set, only those it lists may. */
  access: { canChange: true; limited: boolean } | { canChange: false; reason: string };
  warnings: string[];
}

/**
 * Everything the admin UI can do, for one request that Cloudflare Access let through. The Worker builds it per
 * request and hands it to TanStack Start, whose server functions call it.
 */
export interface AdminApi {
  overview(): Overview;
  /** Counts what the bucket holds, and keeps the result for `lastStorage`. */
  storage(): Promise<SavedStorageReport>;
  lastStorage(): Promise<SavedStorageReport | undefined>;
  tokens(): Promise<Result<TokenSummary[]>>;
  createToken(input: { label?: unknown; scope?: unknown; permission?: unknown }): Promise<Result<{ token: string; entry: TokenSummary }>>;
  revokeToken(id: unknown): Promise<Result<TokenSummary>>;
  /** A page of a repository's locks, of one `path` when it is given. */
  locks(
    repository: unknown,
    cursor?: unknown,
    path?: unknown,
  ): Promise<Result<{ repository: string; locks: LfsLock[]; nextCursor?: string }>>;
  unlock(repository: unknown, id: unknown): Promise<Result<LfsLock>>;
  /** Requests in the last `hours`, by repository or of one `repository`. */
  activity(hours: unknown, repository?: unknown): Promise<Result<Activity>>;
  /** Revokes every short-lived token by replacing the key they are signed with. */
  rotateSessionKey(): Promise<Result<{ rotatedAt: string }>>;
  /** Changes made in the admin UI, newest first, 50 at a time. */
  audit(cursor?: unknown): Promise<Result<{ entries: AuditEntry[]; cursor?: string }>>;
  /** One page of a repository's live or trashed objects (`where`: `live` or `trash`). */
  objects(repository: unknown, where: unknown, cursor?: unknown): Promise<Result<StorageListing & { repository: string }>>;
  /** Trashes, restores or tiers up to MAX_STORAGE_CHANGES objects of a repository. */
  changeObjects(repository: unknown, action: unknown, oids: unknown): Promise<Result<StorageChanges>>;
}
