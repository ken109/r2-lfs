import type { AdminApi, Overview } from "../app/admin-api.ts";
import { forceUnlock, parseRepository, repositoryLocks } from "../app/admin-locks.ts";
import { storageReport } from "../app/admin-storage.ts";
import { createToken, listTokens, revokeToken } from "../app/admin-tokens.ts";
import type { Config } from "../domain/config.ts";
import type { Env } from "../env.ts";
import { R2BucketLister } from "../infra/r2-bucket-lister.ts";
import { R2TokensFile, RandomTokenMinter } from "../infra/r2-tokens-file.ts";
import { DurableObjectLockStore } from "../infra/repo-locks.ts";

const notARepository = { ok: false as const, status: 422, message: "Enter a repository as owner/name" };

/** The admin UI's operations on this Worker's bucket, lock objects and analytics. */
export class WorkerAdminApi implements AdminApi {
  private readonly env: Env;
  private readonly config: Config;
  private readonly email: string;

  constructor(env: Env, config: Config, email: string) {
    this.env = env;
    this.config = config;
    this.email = email;
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
      warnings: [...c.warnings],
    };
  }

  storage() {
    return storageReport(new R2BucketLister(this.env.BUCKET), this.config.storageLayout);
  }

  tokens() {
    return listTokens(new R2TokensFile(this.env.BUCKET));
  }

  createToken(input: { label?: unknown; scope?: unknown; permission?: unknown }) {
    return createToken({ store: new R2TokensFile(this.env.BUCKET), minter: new RandomTokenMinter(), now: () => new Date() }, input);
  }

  revokeToken(id: unknown) {
    return revokeToken(new R2TokensFile(this.env.BUCKET), id);
  }

  async locks(repository: unknown, cursor?: unknown) {
    const repo = parseRepository(repository);
    if (!repo) return notARepository;
    const page = await repositoryLocks(new DurableObjectLockStore(this.env.LOCKS, repo), typeof cursor === "string" ? cursor : undefined);
    return { ok: true as const, value: { repository: `${repo.owner}/${repo.name}`, ...page } };
  }

  unlock(repository: unknown, id: unknown) {
    const repo = parseRepository(repository);
    if (!repo) return Promise.resolve(notARepository);
    return forceUnlock(new DurableObjectLockStore(this.env.LOCKS, repo), id);
  }
}
