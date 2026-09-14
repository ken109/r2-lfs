import type { AuthMode, LfsLock, StorageLayout } from "../shared/contract.ts";
import type { Activity } from "./admin-activity.ts";
import type { StorageReport } from "./admin-storage.ts";
import type { TokenSummary } from "./admin-tokens.ts";
import type { Result } from "./lfs.ts";

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
  actionsOidc?: { permission: "read" | "write"; audience: string };
  warnings: string[];
}

/**
 * Everything the admin UI can do, for one request that Cloudflare Access let through. The Worker builds it per
 * request and hands it to TanStack Start, whose server functions call it.
 */
export interface AdminApi {
  overview(): Overview;
  storage(): Promise<StorageReport>;
  tokens(): Promise<Result<TokenSummary[]>>;
  createToken(input: { label?: unknown; scope?: unknown; permission?: unknown }): Promise<Result<{ token: string; entry: TokenSummary }>>;
  revokeToken(id: unknown): Promise<Result<TokenSummary>>;
  locks(repository: unknown, cursor?: unknown): Promise<Result<{ repository: string; locks: LfsLock[]; nextCursor?: string }>>;
  unlock(repository: unknown, id: unknown): Promise<Result<LfsLock>>;
  activity(hours: unknown): Promise<Result<Activity>>;
}
