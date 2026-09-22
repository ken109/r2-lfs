import { join } from "node:path";

import {
  type AuthMode,
  INCOMING_PREFIX,
  METRICS_DATASET,
  REPO_PATTERN,
  SHARED_PREFIX,
  type StorageLayout,
  TRASH_PREFIX,
  WORKER_COMPATIBILITY_DATE,
} from "../../src/shared/contract.ts";
import { UsageError } from "../domain/errors.ts";
import type { Files, Reporter, Wrangler } from "./ports.ts";

export interface SetupDeps {
  wrangler: Wrangler;
  files: Files;
  reporter: Reporter;
  /** The built Worker shipped with the CLI: its modules and the admin UI's static files. */
  workerFiles: { worker: string; assets: string };
}

export interface SetupOptions {
  name: string;
  bucket: string;
  /** Repository patterns for ALLOWED_REPOS, such as `me/*` or `my-org/blender-*`. */
  repos: string[];
  authMode: AuthMode;
  /** A self-managed Git host; github.com, gitlab.com and bitbucket.org need none. */
  authHost?: string;
  layout: StorageLayout;
  /** 0 disables the lock rules. */
  lockDays: number;
  /** 0 disables the trash expiry rule. */
  trashDays: number;
  deploy: boolean;
  /** The Cloudflare Access application protecting the admin UI; the UI stays closed without it. */
  access?: { teamDomain: string; aud: string };
  /** What GitHub Actions workflows may do in their own repository with an OIDC token. */
  actionsOidc?: "off" | "read" | "write";
  /** The Cloudflare account, for R2_ACCOUNT_ID; setup takes it from Wrangler's login. */
  accountId?: string;
}

export interface SetupResult {
  url?: string;
  lockPrefixes: string[];
}

/** The older --owners form: each owner stands for all of its repositories. */
export function reposOfOwners(owners: string[]): string[] {
  return owners.map((owner) => (owner === "*" ? "*" : `${owner}/*`));
}

/**
 * Lock rules cover the live prefixes only, so gc can still empty `_trash/`. R2 lock rules match a literal
 * prefix, so a pattern is locked up to its first `*`; `unlockable` lists patterns with `*` in the owner,
 * whose prefix would also cover the trash and other owners.
 */
export function lockPrefixes(layout: StorageLayout, repos: string[]): { prefixes: string[]; unlockable: string[] } {
  if (layout === "shared") return { prefixes: [SHARED_PREFIX], unlockable: [] };
  const unlockable: string[] = [];
  const candidates: string[] = [];
  for (const pattern of repos.map((r) => r.toLowerCase())) {
    const star = pattern.indexOf("*");
    if (pattern === "*" || (star !== -1 && star < pattern.indexOf("/"))) unlockable.push(pattern);
    else candidates.push(star === -1 ? `${pattern}/` : pattern.slice(0, star));
  }
  // A prefix inside another, such as me/app/ inside me/, needs no rule of its own.
  const prefixes = [...new Set(candidates)].filter((p, _, all) => !all.some((other) => other !== p && p.startsWith(other)));
  return { prefixes: prefixes.toSorted(), unlockable };
}

export function workerConfig(opts: SetupOptions): Record<string, unknown> {
  return {
    name: opts.name,
    // Already built by Vite: upload the modules as they are.
    main: "worker/index.js",
    base_dir: "worker",
    no_bundle: true,
    find_additional_modules: true,
    rules: [{ type: "ESModule", globs: ["**/*.js"] }],
    compatibility_date: WORKER_COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: "public", run_worker_first: ["/_admin/*"] },
    observability: { enabled: true },
    durable_objects: { bindings: [{ name: "LOCKS", class_name: "RepoLocks" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["RepoLocks"] }],
    analytics_engine_datasets: [{ binding: "METRICS", dataset: METRICS_DATASET }],
    r2_buckets: [{ binding: "BUCKET", bucket_name: opts.bucket }],
    vars: {
      ALLOWED_REPOS: opts.repos.join(","),
      AUTH_MODE: opts.authMode,
      AUTH_HOST: opts.authHost ?? "",
      STORAGE_LAYOUT: opts.layout,
      TRANSFER_MODE: "auto",
      PROXY_MAX_UPLOAD_MB: "100",
      MAX_OBJECT_MB: "",
      QUOTA_GB: "",
      // Presigned URLs and the admin UI's activity page need it.
      R2_ACCOUNT_ID: opts.accountId ?? "",
      R2_BUCKET_NAME: opts.bucket,
      ACCESS_TEAM_DOMAIN: opts.access?.teamDomain ?? "",
      ACCESS_AUD: opts.access?.aud ?? "",
      ADMIN_EMAILS: "",
      ACTIONS_OIDC: opts.actionsOidc ?? "off",
      ACTIONS_OIDC_AUDIENCE: "r2-lfs",
      VERIFY_UPLOADS: "on",
    },
  };
}

function check(result: { code: number; output: string }, what: string, alreadyDone = /already exists|already been/i): "done" | "existed" {
  if (result.code === 0) return "done";
  if (alreadyDone.test(result.output)) return "existed";
  throw new UsageError(`${what} failed:\n${result.output.trim().split("\n").slice(-8).join("\n")}`);
}

export async function setupServer(deps: SetupDeps, opts: SetupOptions): Promise<SetupResult> {
  const { wrangler, files, reporter } = deps;
  if (opts.repos.length === 0) throw new UsageError("--repos is required, e.g. --repos 'my-name/*,my-org/assets'");
  for (const pattern of opts.repos) {
    if (!REPO_PATTERN.test(pattern)) throw new UsageError(`${pattern} is not owner/repo, with * allowed within names, or *`);
  }

  const login = await reporter.task("Checking your Cloudflare login", () => wrangler.whoami());
  if (!login) throw new UsageError("Wrangler is not logged in; run `npx wrangler login` first");

  const created = await reporter.task(`Creating bucket ${opts.bucket}`, () =>
    check(wrangler.run(["r2", "bucket", "create", opts.bucket]), "creating the bucket"),
  );
  if (created === "existed") reporter.info(`Bucket ${opts.bucket} already exists; keeping it`);

  if (opts.trashDays > 0) {
    await reporter.task(`Expiring ${TRASH_PREFIX} after ${opts.trashDays} days`, () =>
      check(
        wrangler.run([
          "r2",
          "bucket",
          "lifecycle",
          "add",
          opts.bucket,
          "r2-lfs-trash",
          TRASH_PREFIX,
          "--expire-days",
          String(opts.trashDays),
          "--force",
        ]),
        "adding the trash lifecycle rule",
      ),
    );
  }
  // Presigned uploads that git-lfs never verified, and multipart uploads abandoned for longer than a resume would wait.
  await reporter.task(`Expiring ${INCOMING_PREFIX} after 1 day`, () =>
    check(
      wrangler.run([
        "r2",
        "bucket",
        "lifecycle",
        "add",
        opts.bucket,
        "r2-lfs-incoming",
        INCOMING_PREFIX,
        "--expire-days",
        "1",
        "--abort-multipart-days",
        "7",
        "--force",
      ]),
      "adding the incoming uploads lifecycle rule",
    ),
  );

  const { prefixes, unlockable } = lockPrefixes(opts.layout, opts.repos);
  if (opts.lockDays > 0) {
    if (unlockable.length > 0) {
      reporter.warn(`${unlockable.join(", ")} cannot be locked without also locking the trash or other owners; no lock rule for them`);
    }
    for (const prefix of prefixes) {
      await reporter.task(`Locking ${prefix} for ${opts.lockDays} days`, () =>
        check(
          wrangler.run([
            "r2",
            "bucket",
            "lock",
            "add",
            opts.bucket,
            `r2-lfs-${prefix.replace(/[^\w-]/g, "")}`,
            prefix,
            "--retention-days",
            String(opts.lockDays),
            "--force",
          ]),
          `locking ${prefix}`,
        ),
      );
    }
  }

  if (!opts.deploy) return { lockPrefixes: prefixes };

  const dir = files.tempDir("r2-lfs-setup-");
  files.copyDir(deps.workerFiles.worker, join(dir, "worker"));
  files.copyDir(deps.workerFiles.assets, join(dir, "public"));
  files.writeText(
    join(dir, "wrangler.json"),
    `${JSON.stringify(workerConfig({ ...(login.accountId ? { accountId: login.accountId } : {}), ...opts }), null, 2)}\n`,
  );
  const deployed = await reporter.task(`Deploying Worker ${opts.name}`, () =>
    // Relative, because npx runs through a shell on Windows and the temp dir may contain spaces.
    wrangler.run(["deploy", "--config", "wrangler.json"], { cwd: dir }),
  );
  check(deployed, "deploying the Worker", /$^/);
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(deployed.output)?.[0];
  return { ...(url ? { url } : {}), lockPrefixes: prefixes };
}
