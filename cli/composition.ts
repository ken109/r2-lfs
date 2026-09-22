// Wires infrastructure into use cases. The only module that constructs adapters.

import { fileURLToPath } from "node:url";

import type { ActionsIdTokens, Bucket, GitRepository, LfsClient, ObjectStorage } from "./app/ports.ts";
import { UsageError } from "./domain/errors.ts";
import { type LfsLocation, parseLfsUrl } from "./domain/remote.ts";
import { GithubActionsIdTokens } from "./infra/actions-id-token.ts";
import { BucketStorage } from "./infra/bucket-storage.ts";
import { Git, gitLfsInstalled } from "./infra/git.ts";
import { GhCli } from "./infra/github-cli.ts";
import { GH_CREDENTIAL_HELPER, UserGitConfig } from "./infra/global-git-config.ts";
import { HttpLfsClient } from "./infra/lfs-client.ts";
import { LocalFiles } from "./infra/local-files.ts";
import { FileUploadStates, HttpMultipartUploads, readFileRange, stdinLines } from "./infra/multipart-uploads.ts";
import { findOnPath } from "./infra/proc.ts";
import { R2Bucket, r2Configured } from "./infra/r2-bucket.ts";
import { ServerStorage } from "./infra/server-storage.ts";
import { FileSessionCache } from "./infra/session-cache.ts";
import { currentCli, joinPath, userCacheDir, userConfigDir } from "./infra/user-dirs.ts";
import { NpxWrangler } from "./infra/wrangler-cli.ts";

export const gitConfig = new UserGitConfig();
/** The credential helper `init` installs, so `doctor` can recognise it. */
export const ghCredentialHelper = GH_CREDENTIAL_HELPER;
export const files = new LocalFiles();
export const wrangler = new NpxWrangler();

export function openRepo(dir?: string): Git {
  return Git.open(dir);
}

export function gh(dir: string = process.cwd()): GhCli {
  return new GhCli(dir);
}

export { gitLfsInstalled };

export function connect(location: LfsLocation, token: string | undefined): LfsClient {
  return new HttpLfsClient(location, token);
}

/** A client for the server in the repository's lfs.url, with whatever credentials git has stored. */
export function clientFor(repo: GitRepository): LfsClient {
  const location = repositoryLocation(repo);
  return connect(location, gitConfig.credentialFor(location.origin));
}

export function actionsIdTokens(): ActionsIdTokens {
  return new GithubActionsIdTokens();
}

/** What installing a launcher needs: this Node and CLI to fall back to, and where to write it. */
export function launcherInstall() {
  return {
    deps: { files, gitConfig, platform: process.platform, configDir: userConfigDir(), join: joinPath },
    target: currentCli(),
  };
}

export { findOnPath };

/** Short-lived tokens the credential helper traded for. */
export function sessionCache(): FileSessionCache {
  return new FileSessionCache(joinPath(userCacheDir(), "sessions"));
}

export function multipartUploads(): HttpMultipartUploads {
  return new HttpMultipartUploads();
}

/** Interrupted uploads, remembered in the clone's git directory. */
export function uploadStates(): FileUploadStates {
  return FileUploadStates.inGitDir(Git.open().commonGitDir());
}

export { readFileRange, stdinLines };

export function bucket(): Bucket {
  return R2Bucket.fromEnv();
}

function repositoryLocation(repo: GitRepository): LfsLocation {
  const raw = repo.lfsUrl();
  if (!raw) throw new UsageError("this repository has no lfs.url; run `r2-lfs init` first");
  const location = parseLfsUrl(raw);
  if (!location) throw new UsageError(`lfs.url "${raw}" does not look like https://<server>/<owner>/<repo>`);
  return location;
}

/** The bucket directly when the R2_* variables are set, otherwise through the server with git's credentials for it. */
export function storageFor(repo: GitRepository): ObjectStorage {
  const location = repositoryLocation(repo);
  if (r2Configured()) return new BucketStorage(R2Bucket.fromEnv(), location);
  const token = gitConfig.credentialFor(location.origin);
  if (!token) {
    throw new UsageError(
      `no credentials for ${location.host}; push once so git stores them, or set the R2_* variables to use the bucket directly`,
    );
  }
  return new ServerStorage(location, token);
}

/** Storage for commands where listing objects only adds detail: undefined when neither the bucket nor the server can list. */
export async function optionalStorage(repo: GitRepository): Promise<ObjectStorage | undefined> {
  const location = repositoryLocation(repo);
  if (r2Configured()) return new BucketStorage(R2Bucket.fromEnv(), location);
  const token = gitConfig.credentialFor(location.origin);
  if (!token) return undefined;
  const info = await connect(location, token)
    .info()
    .catch(() => undefined);
  return info?.kind === "ok" && info.info.storage ? new ServerStorage(location, token) : undefined;
}

export { r2Configured };

/** The built Worker published next to the CLI in dist/. */
export function workerFiles(): { worker: string; assets: string } {
  return { worker: fileURLToPath(new URL("./worker", import.meta.url)), assets: fileURLToPath(new URL("./public", import.meta.url)) };
}
