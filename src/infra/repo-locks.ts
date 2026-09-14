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

/** Locks live per repository, in every storage layout: a lock names a path in one repository. */
export class DurableObjectLockStore implements LockStore {
  private readonly stub: DurableObjectStub<RepoLocks>;

  constructor(namespace: DurableObjectNamespace<RepoLocks>, repo: Repo) {
    this.stub = namespace.getByName(`${repo.owner}/${repo.name}`.toLowerCase());
  }

  create(path: string, owner: string) {
    return this.stub.create(path, owner);
  }

  list(filter: { path?: string; id?: string; cursor?: string; limit: number }) {
    return this.stub.list(filter);
  }

  find(id: string) {
    return this.stub.find(id);
  }

  remove(id: string) {
    return this.stub.remove(id);
  }
}
