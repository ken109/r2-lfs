import { OWNER_NAME, REPO_NAME } from "../../src/shared/contract.ts";

export interface LfsLocation {
  /** The full `lfs.url`, e.g. `https://lfs.example.com/owner/repo`. */
  url: string;
  origin: string;
  host: string;
  owner: string;
  repo: string;
}

const LFS_PATH = new RegExp(`^/(${OWNER_NAME})/(${REPO_NAME}?)(?:\\.git)?(?:/info/lfs)?/?$`);

export function parseLfsUrl(raw: string): LfsLocation | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const match = LFS_PATH.exec(url.pathname);
  if (!match) return undefined;
  return { url: raw.replace(/\/+$/, ""), origin: url.origin, host: url.host, owner: match[1]!, repo: match[2]! };
}

/** Extracts `owner/repo` from GitHub-style remote URLs (https, ssh and scp-like). */
export function parseRemote(url: string): { host: string; owner: string; repo: string } | undefined {
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:[^@]+@)?([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) return undefined;
  return { host: match[1]!, owner: match[2]!, repo: match[3]! };
}

/** Where GitHub serves LFS for a repository, used as the source when migrating away from it. */
export function githubLfsEndpoint(remote: { host: string; owner: string; repo: string }): string {
  return `https://${remote.host}/${remote.owner}/${remote.repo}.git/info/lfs`;
}
