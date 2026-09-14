// Wires infrastructure into use cases. The only module that constructs adapters.

import { fileURLToPath } from "node:url";

import type { ActionsIdTokens, Bucket, GitRepository, LfsClient } from "./app/ports.ts";
import { UsageError } from "./domain/errors.ts";
import { type LfsLocation, parseLfsUrl } from "./domain/remote.ts";
import { GithubActionsIdTokens } from "./infra/actions-id-token.ts";
import { Git, gitLfsInstalled } from "./infra/git.ts";
import { GhCli } from "./infra/github-cli.ts";
import { GH_CREDENTIAL_HELPER, UserGitConfig } from "./infra/global-git-config.ts";
import { HttpLfsClient } from "./infra/lfs-client.ts";
import { LocalFiles } from "./infra/local-files.ts";
import { FileUploadStates, HttpMultipartUploads, readFileRange, stdinLines } from "./infra/multipart-uploads.ts";
import { R2Bucket, r2Configured } from "./infra/r2-bucket.ts";
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
  const raw = repo.lfsUrl();
  if (!raw) throw new UsageError("this repository has no lfs.url; run `r2-lfs init` first");
  const location = parseLfsUrl(raw);
  if (!location) throw new UsageError(`lfs.url "${raw}" does not look like https://<server>/<owner>/<repo>`);
  return connect(location, gitConfig.credentialFor(location.origin));
}

export function actionsIdTokens(): ActionsIdTokens {
  return new GithubActionsIdTokens();
}

/** How git runs `r2-lfs credential`: this Node.js and this CLI, quoted for the shell git uses. */
export function credentialHelperCommand(): string {
  return `!"${process.execPath}" "${process.argv[1] ?? ""}" credential`;
}

/** How git-lfs runs `r2-lfs transfer-agent`: git-lfs splits the args itself, without a shell. */
export function transferAgentCommand(): { path: string; args: string } {
  return { path: process.execPath, args: `"${process.argv[1] ?? ""}" transfer-agent` };
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

/** The bucket when R2 credentials are set, for commands where bucket access only adds detail. */
export function optionalBucket(): Bucket | undefined {
  return r2Configured() ? R2Bucket.fromEnv() : undefined;
}

export { r2Configured };

/** The built Worker published next to the CLI in dist/. */
export function workerFiles(): { worker: string; assets: string } {
  return { worker: fileURLToPath(new URL("./worker", import.meta.url)), assets: fileURLToPath(new URL("./public", import.meta.url)) };
}
