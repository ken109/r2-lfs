import { join } from "node:path";

import { OWNER_NAME, SHARED_PREFIX, type StorageLayout, TRASH_PREFIX, WORKER_COMPATIBILITY_DATE } from "../../src/shared/contract.ts";
import { UsageError } from "../domain/errors.ts";
import type { Files, Reporter, Wrangler } from "./ports.ts";

export interface SetupDeps {
  wrangler: Wrangler;
  files: Files;
  reporter: Reporter;
  /** The bundled Worker shipped with the CLI. */
  workerBundle: string;
}

export interface SetupOptions {
  name: string;
  bucket: string;
  owners: string[];
  authMode: "github" | "token";
  layout: StorageLayout;
  /** 0 disables the lock rules. */
  lockDays: number;
  /** 0 disables the trash expiry rule. */
  trashDays: number;
  deploy: boolean;
}

export interface SetupResult {
  url?: string;
  lockPrefixes: string[];
}

const OWNER = new RegExp(`^${OWNER_NAME}$`);

/** Lock rules cover the live prefixes only, so gc can still empty `_trash/`. */
export function lockPrefixes(layout: StorageLayout, owners: string[]): string[] {
  return layout === "shared" ? [SHARED_PREFIX] : owners.map((o) => `${o.toLowerCase()}/`);
}

export function workerConfig(opts: SetupOptions): Record<string, unknown> {
  return {
    name: opts.name,
    main: "worker.js",
    compatibility_date: WORKER_COMPATIBILITY_DATE,
    observability: { enabled: true },
    r2_buckets: [{ binding: "BUCKET", bucket_name: opts.bucket }],
    vars: {
      ALLOWED_OWNERS: opts.owners.join(","),
      AUTH_MODE: opts.authMode,
      STORAGE_LAYOUT: opts.layout,
      TRANSFER_MODE: "auto",
      PROXY_MAX_UPLOAD_MB: "100",
      R2_BUCKET_NAME: opts.bucket,
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
  if (opts.owners.length === 0) throw new UsageError("--owners is required, e.g. --owners my-name,my-org");
  const wildcard = opts.owners.includes("*");
  for (const owner of opts.owners) {
    if (owner !== "*" && !OWNER.test(owner)) throw new UsageError(`${owner} is not a valid GitHub user or organization name`);
  }

  const account = await reporter.task("Checking your Cloudflare login", () => wrangler.whoami());
  if (!account) throw new UsageError("Wrangler is not logged in; run `npx wrangler login` first");

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

  const prefixes = wildcard && opts.layout === "per-repo" ? [] : lockPrefixes(opts.layout, opts.owners);
  if (opts.lockDays > 0) {
    if (prefixes.length === 0)
      reporter.warn("ALLOWED_OWNERS is *, so there is no prefix to lock without also locking the trash; skipping lock rules");
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
  files.copyFile(deps.workerBundle, join(dir, "worker.js"));
  files.writeText(join(dir, "wrangler.json"), `${JSON.stringify(workerConfig(opts), null, 2)}\n`);
  const deployed = await reporter.task(`Deploying Worker ${opts.name}`, () =>
    // Relative, because npx runs through a shell on Windows and the temp dir may contain spaces.
    wrangler.run(["deploy", "--config", "wrangler.json"], { cwd: dir }),
  );
  check(deployed, "deploying the Worker", /$^/);
  const url = /https:\/\/[\w.-]+\.workers\.dev/.exec(deployed.output)?.[0];
  return { ...(url ? { url } : {}), lockPrefixes: prefixes };
}
