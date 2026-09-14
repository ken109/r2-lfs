import type { ServerInfo } from "../../src/shared/contract.ts";
import { UsageError } from "../domain/errors.ts";
import { expandTracks } from "../domain/presets.ts";
import { type LfsLocation, parseLfsUrl, parseRemote } from "../domain/remote.ts";
import { requireServerInfo } from "./common.ts";
import { BatchRequestError, type GitHubCli, type GitRepository, type GlobalGitConfig, type LfsClient, type Reporter } from "./ports.ts";
import { transferAgentConfig } from "./transfer-agent.ts";

export const SERVER_CONFIG_KEY = "r2-lfs.server";

export interface InitDeps {
  repo: GitRepository;
  gitConfig: GlobalGitConfig;
  gh: GitHubCli;
  reporter: Reporter;
  connect: (location: LfsLocation, token: string | undefined) => LfsClient;
}

export interface InitOptions {
  server: string;
  /** `owner/name`; derived from the origin remote when omitted. */
  repo?: string;
  track: string[];
  /** Track the patterns as lockable, so git keeps them read-only until someone locks them. */
  lockable?: boolean;
  /** Defaults to "gh" when the server uses GitHub auth and gh is logged in. */
  credential?: "gh" | "none";
  /** How git-lfs runs `r2-lfs transfer-agent`, to register it for uploads past the Worker's request limit. */
  transferAgent?: { path: string; args: string };
}

export interface InitResult {
  location: LfsLocation;
  info: ServerInfo;
  credential: "gh" | "none";
  access: "write" | "read" | "unknown";
}

export function normalizeServer(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/.test(trimmed)) throw new UsageError(`${raw} should be just an origin, like https://r2-lfs.example.workers.dev`);
  return trimmed;
}

function ownerAndRepo(repo: GitRepository, explicit: string | undefined): { owner: string; name: string } {
  if (explicit) {
    const [owner, name, extra] = explicit.split("/");
    if (!owner || !name || extra !== undefined) throw new UsageError("--repo must look like owner/name");
    return { owner, name };
  }
  const remote = repo.remoteUrl();
  const parsed = remote ? parseRemote(remote) : undefined;
  if (!parsed) throw new UsageError("cannot tell owner/name from the origin remote; pass --repo owner/name");
  return { owner: parsed.owner, name: parsed.repo };
}

/** Probes what the stored credentials can do: an empty upload batch needs write access. */
export async function probeAccess(client: LfsClient): Promise<"write" | "read"> {
  try {
    await client.batch("upload", []);
    return "write";
  } catch (err) {
    if (!(err instanceof BatchRequestError) || err.status !== 403) throw err;
    await client.batch("download", []);
    return "read";
  }
}

export async function initRepository(deps: InitDeps, opts: InitOptions): Promise<InitResult> {
  const { repo, gitConfig, gh, reporter } = deps;
  const server = normalizeServer(opts.server);
  const { owner, name } = ownerAndRepo(repo, opts.repo);
  const location = parseLfsUrl(`${server}/${owner}/${name}`);
  if (!location) throw new UsageError(`${server}/${owner}/${name} is not a valid r2-lfs URL`);

  const info = await requireServerInfo(deps.connect(location, undefined));
  reporter.step(`Server ${server}: ${info.authMode} auth, ${info.storageLayout} layout, ${info.transfer} transfers`);

  if (!repo.lfsInstalled()) throw new UsageError("git-lfs is not installed; see https://git-lfs.com");
  if (!repo.lfsHooksInstalled()) throw new UsageError("git-lfs hooks are not set up for your user; run `git lfs install` once");

  repo.setLfsConfig("lfs.url", location.url);
  // The server supports file locks, so git-lfs checks them before a push.
  repo.setLfsConfig("lfs.locksverify", "true");
  reporter.success(`Wrote .lfsconfig: ${location.url}`);

  const patterns = expandTracks(opts.track);
  if (patterns.length > 0) {
    repo.lfsTrack(patterns, { lockable: opts.lockable ?? false });
    reporter.success(`Tracking ${patterns.join(" ")}${opts.lockable ? " as lockable" : ""}`);
  }

  // gh answers for github.com; other hosts need their own token.
  const githubDotCom = info.authMode === "github" && (info.authHost ?? "https://github.com") === "https://github.com";
  const credential = opts.credential ?? (githubDotCom && gh.loggedIn() ? "gh" : "none");
  if (credential === "gh") {
    if (!githubDotCom)
      reporter.warn(
        `The server checks ${info.authMode === "token" ? "its own tokens" : info.authHost}, so it will not accept a github.com login`,
      );
    if (!gh.loggedIn()) throw new UsageError("--credential gh needs the GitHub CLI to be logged in (gh auth login)");
    gitConfig.useGhCredentials(location.origin);
    reporter.success(`Git will use your gh login for ${location.host}`);
  }

  if (opts.transferAgent) {
    for (const [key, value] of transferAgentConfig(opts.transferAgent.path, opts.transferAgent.args)) gitConfig.set(key, value);
    reporter.success("git-lfs will upload through the r2-lfs transfer agent, in resumable parts");
  }

  if (!gitConfig.get(SERVER_CONFIG_KEY)) gitConfig.set(SERVER_CONFIG_KEY, server);

  const client = deps.connect(location, gitConfig.credentialFor(location.origin));
  const access = client.hasCredentials ? await probeAccess(client) : "unknown";
  return { location, info, credential, access };
}
