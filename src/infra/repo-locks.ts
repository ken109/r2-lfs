import { DurableObject } from "cloudflare:workers";

import type { LockStore } from "../app/ports.ts";
import type { Repo } from "../domain/repo.ts";
import type { LfsLock } from "../shared/contract.ts";

interface LockRow extends Record<string, SqlStorageValue> {
  seq: number;
  id: string;
  path: string;
  owner: string;
  locked_at: string;
}

const toLock = (row: LockRow): LfsLock => ({ id: row.id, path: row.path, locked_at: row.locked_at, owner: { name: row.owner } });

/** The file locks of one repository, in SQLite, so creating a lock is atomic. */
export class RepoLocks extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS locks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, path TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, locked_at TEXT NOT NULL)",
    );
  }

  create(path: string, owner: string): { created: boolean; lock: LfsLock } {
    const sql = this.ctx.storage.sql;
    const id = crypto.randomUUID();
    sql.exec(
      "INSERT INTO locks (id, path, owner, locked_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO NOTHING",
      id,
      path,
      owner,
      new Date().toISOString(),
    );
    // rowsWritten also counts SQLite's own bookkeeping, so the id tells whether this call made the lock.
    const row = sql.exec<LockRow>("SELECT * FROM locks WHERE path = ?", path).one();
    return { created: row.id === id, lock: toLock(row) };
  }

  list(filter: { path?: string; id?: string; cursor?: string; limit: number }): { locks: LfsLock[]; nextCursor?: string } {
    const after = Number(filter.cursor ?? 0) || 0;
    const rows = this.ctx.storage.sql
      .exec<LockRow>(
        "SELECT * FROM locks WHERE seq > ? AND (? IS NULL OR path = ?) AND (? IS NULL OR id = ?) ORDER BY seq LIMIT ?",
        after,
        filter.path ?? null,
        filter.path ?? null,
        filter.id ?? null,
        filter.id ?? null,
        filter.limit + 1,
      )
      .toArray();
    const page = rows.slice(0, filter.limit);
    return { locks: page.map(toLock), ...(rows.length > filter.limit ? { nextCursor: String(page.at(-1)!.seq) } : {}) };
  }

  find(id: string): LfsLock | undefined {
    const [row] = this.ctx.storage.sql.exec<LockRow>("SELECT * FROM locks WHERE id = ?", id).toArray();
    return row ? toLock(row) : undefined;
  }

  remove(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM locks WHERE id = ?", id);
  }
}

const ATTEMPTS = 3;

/** Cloudflare marks Durable Object errors worth another try, such as a lost connection while the object restarts. */
function retryable(err: unknown): boolean {
  const flags = err as { retryable?: boolean; overloaded?: boolean } | null;
  return flags?.retryable === true && flags.overloaded !== true;
}

/** Locks live per repository, in every storage layout: a lock names a path in one repository. */
export class DurableObjectLockStore implements LockStore {
  private readonly namespace: DurableObjectNamespace<RepoLocks>;
  private readonly name: string;

  constructor(namespace: DurableObjectNamespace<RepoLocks>, repo: Repo) {
    this.namespace = namespace;
    this.name = `${repo.owner}/${repo.name}`.toLowerCase();
  }

  /** Runs `call` on a fresh stub each attempt, since a stub that threw may stay broken. */
  private async withStub<T>(call: (stub: DurableObjectStub<RepoLocks>, attempt: number) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call(this.namespace.getByName(this.name), attempt);
      } catch (err) {
        if (attempt >= ATTEMPTS || !retryable(err)) throw err;
      }
    }
  }

  create(path: string, owner: string) {
    return this.withStub(async (stub, attempt) => {
      const result = await stub.create(path, owner);
      // An earlier attempt may have made the lock before its answer was lost.
      return attempt > 1 && !result.created && result.lock.owner.name === owner ? { ...result, created: true } : result;
    });
  }

  list(filter: { path?: string; id?: string; cursor?: string; limit: number }) {
    return this.withStub((stub) => stub.list(filter));
  }

  find(id: string) {
    return this.withStub((stub) => stub.find(id));
  }

  remove(id: string) {
    return this.withStub((stub) => stub.remove(id));
  }
}
