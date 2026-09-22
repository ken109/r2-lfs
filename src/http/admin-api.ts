import { recentActivity } from "../app/admin-activity.ts";
import type { AdminApi, Overview } from "../app/admin-api.ts";
import { audited, auditLog } from "../app/admin-audit.ts";
import { forceUnlock, repositoryLocks, servedRepository } from "../app/admin-locks.ts";
import { changeRepositoryObjects, repositoryObjects } from "../app/admin-objects.ts";
import { rotateSessionKey } from "../app/admin-sessions.ts";
import { countStorage, lastStorageReport } from "../app/admin-storage.ts";
import { createToken, listTokens, revokeToken } from "../app/admin-tokens.ts";
import { changeRefusal } from "../app/admin.ts";
import type { Result } from "../app/lfs.ts";
import type { Config } from "../domain/config.ts";
import type { Env } from "../env.ts";
import { AnalyticsSqlActivity } from "../infra/analytics-sql.ts";
import type { Fetcher } from "../infra/host-permissions.ts";
import { R2AuditLog } from "../infra/r2-audit-log.ts";
import { R2BucketLister } from "../infra/r2-bucket-lister.ts";
import { R2RepositoryStorage } from "../infra/r2-repository-storage.ts";
import { R2SessionKey } from "../infra/r2-session-key.ts";
import { R2StorageReport } from "../infra/r2-storage-report.ts";
import { R2TokensFile, RandomTokenMinter } from "../infra/r2-tokens-file.ts";
import { DurableObjectLockStore } from "../infra/repo-locks.ts";

const text = (value: unknown) => (typeof value === "string" ? value : (JSON.stringify(value) ?? ""));

/** The admin UI's operations on this Worker's bucket, lock objects and analytics. */
export class WorkerAdminApi implements AdminApi {
  private readonly env: Env;
  private readonly config: Config;
  private readonly email: string;
  private readonly fetcher: Fetcher;
  /** Why this person may only look, when ADMIN_EMAILS leaves them out. */
  private readonly refusal: string | undefined;

  constructor(env: Env, config: Config, email: string, fetcher: Fetcher) {
    this.env = env;
    this.config = config;
    this.email = email;
    this.fetcher = fetcher;
    this.refusal = changeRefusal(config, email);
  }

  /** Every change goes through here: refused for those who may only look, and recorded in the audit log. */
  private change<T>(change: { action: string; target: string; detail?: (value: T) => string | undefined }, run: () => Promise<Result<T>>) {
    return audited({ log: new R2AuditLog(this.env.BUCKET), email: this.email, refusal: this.refusal, now: () => new Date() }, change, run);
  }

  overview(): Overview {
    const c = this.config;
    return {
      email: this.email,
      authMode: c.authMode,
      ...(c.authMode === "token" ? {} : { authHost: c.host.url }),
      storageLayout: c.storageLayout,
      transfer: c.presign ? "presigned" : "proxy",
      encrypted: c.encryptionKey !== undefined,
      verifyUploads: c.verifyUploads,
      allowedRepos: [...c.allowedRepos],
      proxyMaxUploadBytes: c.proxyMaxUploadBytes,
      ...(c.maxObjectBytes === undefined ? {} : { maxObjectBytes: c.maxObjectBytes }),
      ...(c.quotaBytes === undefined ? {} : { quotaBytes: c.quotaBytes }),
      staticTokens: c.tokens.length,
      ...(c.actionsOidc ? { actionsOidc: c.actionsOidc } : {}),
      // As INFO_PATH reports them.
      endpoints: { sessions: true, storage: c.storageLayout === "per-repo" },
      access:
        this.refusal === undefined ? { canChange: true, limited: c.adminEmails !== undefined } : { canChange: false, reason: this.refusal },
      warnings: [...c.warnings],
    };
  }

  storage() {
    return countStorage({
      lister: new R2BucketLister(this.env.BUCKET),
      layout: this.config.storageLayout,
      store: new R2StorageReport(this.env.BUCKET),
      now: () => new Date(),
    });
  }

  lastStorage() {
    return lastStorageReport(new R2StorageReport(this.env.BUCKET));
  }

  tokens() {
    return listTokens(new R2TokensFile(this.env.BUCKET));
  }

  createToken(input: { label?: unknown; scope?: unknown; permission?: unknown }) {
    return this.change(
      { action: "token.create", target: text(input.label), detail: ({ entry }) => `${entry.id}, ${entry.scope}, ${entry.permission}` },
      () => createToken({ store: new R2TokensFile(this.env.BUCKET), minter: new RandomTokenMinter(), now: () => new Date() }, input),
    );
  }

  revokeToken(id: unknown) {
    return this.change(
      { action: "token.revoke", target: text(id), detail: (entry) => `${entry.label}, ${entry.scope}, ${entry.permission}` },
      () => revokeToken(new R2TokensFile(this.env.BUCKET), id),
    );
  }

  async locks(repository: unknown, cursor?: unknown, path?: unknown) {
    const repo = servedRepository(this.config, repository);
    if (!repo.ok) return repo;
    const page = await repositoryLocks(
      new DurableObjectLockStore(this.env.LOCKS, repo.value),
      typeof cursor === "string" ? cursor : undefined,
      typeof path === "string" ? path.trim() : undefined,
    );
    return { ok: true as const, value: { repository: `${repo.value.owner}/${repo.value.name}`, ...page } };
  }

  unlock(repository: unknown, id: unknown) {
    return this.change(
      {
        action: "lock.unlock",
        target: text(repository),
        detail: (lock) => `${lock.path}, held by ${lock.owner.name} since ${lock.locked_at}`,
      },
      async () => {
        const repo = servedRepository(this.config, repository);
        if (!repo.ok) return repo;
        return forceUnlock(new DurableObjectLockStore(this.env.LOCKS, repo.value), id);
      },
    );
  }

  activity(hours: unknown, repository?: unknown) {
    const source = this.config.analytics ? new AnalyticsSqlActivity(this.fetcher, this.config.analytics) : undefined;
    return recentActivity(source, hours, repository);
  }

  rotateSessionKey() {
    return this.change({ action: "session-key.rotate", target: "_meta/session-key" }, () =>
      rotateSessionKey({ keys: new R2SessionKey(this.env.BUCKET), now: () => new Date() }),
    );
  }

  private objectsDeps() {
    return { config: this.config, storage: new R2RepositoryStorage(this.env.BUCKET, this.config.encryptionKey) };
  }

  objects(repository: unknown, where: unknown, cursor?: unknown) {
    return repositoryObjects(this.objectsDeps(), repository, where, cursor);
  }

  changeObjects(repository: unknown, action: unknown, oids: unknown) {
    return this.change(
      {
        action: `objects.${text(action)}`,
        target: text(repository),
        detail: ({ results }) => results.map((r) => `${r.oid.slice(0, 12)} ${r.outcome}`).join(", "),
      },
      () => changeRepositoryObjects(this.objectsDeps(), repository, action, oids),
    );
  }

  audit(cursor?: unknown) {
    return auditLog(new R2AuditLog(this.env.BUCKET), cursor);
  }
}
