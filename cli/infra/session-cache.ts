import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Session, SessionCache } from "../app/ports.ts";
import type { LfsLocation } from "../domain/remote.ts";

/** One small JSON file per repository, readable only by the user: `<dir>/<host>/<owner>/<repo>.json`. */
export class FileSessionCache implements SessionCache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(location: LfsLocation): string {
    // Host names may carry a port; `:` is not allowed in Windows file names.
    const host = location.host.toLowerCase().replaceAll(":", "_");
    return join(this.dir, host, location.owner.toLowerCase(), `${location.repo.toLowerCase()}.json`);
  }

  get(location: LfsLocation): Session | undefined {
    try {
      const body = JSON.parse(readFileSync(this.path(location), "utf8")) as { token?: unknown; expires_at?: unknown };
      const expiresAt = new Date(typeof body.expires_at === "string" ? body.expires_at : Number.NaN);
      return typeof body.token === "string" && !Number.isNaN(expiresAt.getTime()) ? { token: body.token, expiresAt } : undefined;
    } catch {
      return undefined;
    }
  }

  set(location: LfsLocation, session: Session): void {
    const path = this.path(location);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify({ token: session.token, expires_at: session.expiresAt.toISOString() }), { mode: 0o600 });
    } catch {
      // Without a cache every git command trades for a new token, which still works.
    }
  }

  delete(location: LfsLocation): void {
    rmSync(this.path(location), { force: true });
  }
}
