import { UsageError } from "../domain/errors.ts";
import { githubLfsEndpoint, parseLfsUrl, parseRemote } from "../domain/remote.ts";
import { type InitDeps, type InitOptions, initRepository, normalizeServer } from "./init.ts";
import type { Reporter } from "./ports.ts";
import { verifyObjects } from "./verify.ts";

export interface MigrateOptions extends InitOptions {
  /** LFS endpoint to copy from; defaults to GitHub's for the origin remote. */
  from?: string;
  remote: string;
  /** Patterns of files committed without LFS to convert, which rewrites history. */
  importPatterns: string[];
  rewriteHistory: boolean;
  commit: boolean;
}

export interface MigrateResult {
  url: string;
  committed: boolean;
  rewroteHistory: boolean;
  missingAfterPush: number;
}

async function mustSucceed(reporter: Reporter, what: string, run: () => Promise<number>): Promise<void> {
  reporter.step(what);
  const code = await run();
  if (code !== 0)
    throw new UsageError(`${what} failed (exit ${code}); nothing was deleted, so you can fix the problem and run migrate again`);
}

/**
 * Copies every LFS object from the current endpoint to r2-lfs:
 * fetch all versions from the old server, point the repository at r2-lfs, push all versions, verify.
 */
export async function migrate(deps: InitDeps, opts: MigrateOptions): Promise<MigrateResult> {
  const { repo, reporter } = deps;
  if (!repo.isClean()) throw new UsageError("commit or stash your changes first; migrate commits .lfsconfig and may rewrite history");
  if (opts.importPatterns.length > 0 && !opts.rewriteHistory) {
    throw new UsageError("--import rewrites every commit that contains matching files; add --rewrite-history to confirm");
  }

  const current = repo.lfsUrl();
  const alreadyMigrated = current !== undefined && parseLfsUrl(current)?.origin === normalizeServer(opts.server);
  let from = opts.from;
  if (!from && !alreadyMigrated) {
    const remote = parseRemote(repo.remoteUrl(opts.remote) ?? "");
    if (!remote) throw new UsageError(`cannot derive the current LFS endpoint from remote ${opts.remote}; pass --from <url>`);
    from = current ?? githubLfsEndpoint(remote);
  }

  if (from) {
    await mustSucceed(reporter, `Downloading every LFS version from ${from}`, () =>
      repo.lfsFetch(opts.remote, [], { all: true, url: from }),
    );
  } else {
    reporter.info("This repository already points at the r2-lfs server; uploading what you have locally");
  }

  if (opts.importPatterns.length > 0) {
    await mustSucceed(reporter, `Converting ${opts.importPatterns.join(", ")} to LFS across all history`, () =>
      repo.lfsMigrateImport(opts.importPatterns),
    );
  }

  const init = await initRepository(deps, opts);
  const committed = opts.commit ? repo.commitFiles([".lfsconfig", ".gitattributes"], "Store LFS objects on r2-lfs") : false;

  await mustSucceed(reporter, `Uploading every LFS version to ${init.location.url}`, () => repo.lfsPushAll(opts.remote));

  const client = deps.connect(init.location, deps.gitConfig.credentialFor(init.location.origin));
  const verified = await verifyObjects({ repo, client, reporter }, { all: true, deep: false });
  return {
    url: init.location.url,
    committed,
    rewroteHistory: opts.importPatterns.length > 0,
    missingAfterPush: verified.missing.length,
  };
}
