import { MAX_POINTER_SIZE } from "../domain/pointer.ts";
import { type LfsLocation, parseLfsUrl } from "../domain/remote.ts";
import { probeAccess } from "./init.ts";
import { BatchRequestError, type GitHubCli, type GitRepository, type GlobalGitConfig, type InfoResult, type LfsClient } from "./ports.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  /** Undefined when the working directory is not a repository; `openError` says why. */
  repo: GitRepository | undefined;
  openError?: string;
  lfsInstalled: boolean;
  gitConfig: GlobalGitConfig;
  gh: GitHubCli;
  connect: (location: LfsLocation, token: string | undefined) => LfsClient;
  r2Configured: boolean;
  /** Helper string `init --credential gh` installs, to recognise it. */
  ghHelper: string;
}

export const LARGE_FILE_BYTES = 10 * 1024 * 1024;

/** Runs checks in dependency order and stops at the first one later checks cannot work without. */
export async function diagnose(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string, fix?: string) =>
    checks.push({ name, status, detail, ...(fix ? { fix } : {}) });

  if (!deps.lfsInstalled) {
    add("git-lfs", "fail", "git-lfs is not installed", "Install it from https://git-lfs.com");
    return checks;
  }
  add("git-lfs", "ok", "installed");

  const { repo } = deps;
  if (!repo) {
    add("repository", "fail", deps.openError ?? "not inside a git repository");
    return checks;
  }
  if (repo.lfsHooksInstalled()) add("hooks", "ok", "git-lfs filters are configured");
  else add("hooks", "fail", "git-lfs filters are not configured", "git lfs install");

  const raw = repo.lfsUrl();
  const location = raw ? parseLfsUrl(raw) : undefined;
  if (!raw || !location) {
    add("lfs.url", "fail", raw ? `${raw} is not https://<server>/<owner>/<repo>` : "no lfs.url in git config or .lfsconfig", "r2-lfs init");
    return checks;
  }
  add("lfs.url", "ok", raw);

  const locksOff = repo.config("lfs.locksverify") === "false" || repo.config("lfs.locksverify", ".lfsconfig") === "false";
  if (locksOff) add("locking", "ok", "lock verification is off (r2-lfs does not implement locks)");
  else add("locking", "warn", "git-lfs will try the locking API on every push", "git config -f .lfsconfig lfs.locksverify false");

  const token = deps.gitConfig.credentialFor(location.origin);
  const client = deps.connect(location, token);
  let info: InfoResult;
  try {
    info = await client.info();
  } catch (err) {
    add("server", "fail", `cannot reach ${location.origin}: ${err instanceof Error ? err.message : String(err)}`);
    return checks;
  }
  if (info.kind === "misconfigured") {
    add("server", "fail", `misconfigured: ${info.problems.join("; ")}`, "Fix the Worker's variables and redeploy");
    return checks;
  }
  if (info.kind === "not-r2-lfs") {
    add("server", "fail", `${location.origin} answered ${info.status} but is not an r2-lfs server`);
    return checks;
  }
  add(
    "server",
    "ok",
    `r2-lfs ${info.info.version}, ${info.info.authMode} auth, ${info.info.storageLayout} layout, ${info.info.transfer} transfers`,
  );

  if (!client.hasCredentials) {
    const fix =
      info.info.authMode === "github" && deps.gh.loggedIn() ? "r2-lfs init --credential gh" : "Push once and enter a token when git asks";
    add("credentials", "warn", `no stored credentials for ${location.host}`, fix);
  } else {
    const fromGh = deps.gitConfig.helpersFor(location.origin).includes(deps.ghHelper);
    add("credentials", "ok", fromGh ? "from your gh login" : "found by git's credential helper");
    try {
      const access = await probeAccess(client);
      if (access === "write") add("access", "ok", "read and write");
      else add("access", "warn", "read only; pushing LFS files will fail");
    } catch (err) {
      if (!(err instanceof BatchRequestError)) throw err;
      const fix =
        err.status === 401 ? "The stored credentials were rejected; clear them with `git credential reject` and push again" : undefined;
      add("access", "fail", `${err.status}: ${err.message}`, fix);
    }
  }

  try {
    const head = repo.resolveCommit("HEAD");
    const large = repo.treeEntries(head).filter((e) => e.type === "blob" && e.size >= Math.max(LARGE_FILE_BYTES, MAX_POINTER_SIZE));
    if (large.length === 0) add("large files", "ok", "no file over 10 MB is committed without LFS");
    else {
      const list = large
        .slice(0, 5)
        .map((e) => e.path)
        .join(", ");
      add(
        "large files",
        "warn",
        `${large.length} file(s) over 10 MB are committed without LFS: ${list}`,
        "r2-lfs migrate --import '<pattern>' --rewrite-history",
      );
    }
  } catch {
    // No commits yet; nothing to inspect.
  }

  if (deps.r2Configured) add("R2 credentials", "ok", "set; gc, restore and token can run");
  else
    add(
      "R2 credentials",
      "warn",
      "not set; gc, restore and token need R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY",
    );
  return checks;
}
