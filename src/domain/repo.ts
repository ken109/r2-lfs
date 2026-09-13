import { repoPrefix, type StorageLayout } from "../shared/contract.ts";

export interface Repo {
  /** As written in the URL; used for GitHub API calls. */
  owner: string;
  name: string;
}

export function objectKey(layout: StorageLayout, repo: Repo, oid: string): string {
  return `${repoPrefix(layout, repo.owner, repo.name)}${oid}`;
}

/** Dot segments would be collapsed in presigned URLs and escape the repository's prefix. */
export function isSafeRepoName(name: string): boolean {
  return !/^\.+$/.test(name);
}
