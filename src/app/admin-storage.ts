import { INCOMING_PREFIX, MEMBERS_PREFIX, SHARED_PREFIX, type StorageLayout, TOKENS_KEY, TRASH_PREFIX } from "../shared/contract.ts";
import type { BucketLister } from "./ports.ts";

export interface Tally {
  objects: number;
  bytes: number;
}

export interface StorageReport {
  /** Per repository, largest first. In the shared layout, the objects each repository has uploaded. */
  repositories: ({ repo: string } & Tally)[];
  total: Tally;
  trash: Tally;
  incoming: Tally;
  /** True when the listing stopped at `maxPages`, so the numbers are a lower bound. */
  truncated: boolean;
}

const OID = /^[0-9a-f]{64}$/;

function add(tally: Tally, bytes: number): void {
  tally.objects++;
  tally.bytes += bytes;
}

/** Walks the bucket and totals what each repository stores. */
export async function storageReport(lister: BucketLister, layout: StorageLayout, maxPages = 100): Promise<StorageReport> {
  const repos = new Map<string, Tally>();
  const sharedSizes = new Map<string, number>();
  const members: { repo: string; oid: string }[] = [];
  const total: Tally = { objects: 0, bytes: 0 };
  const trash: Tally = { objects: 0, bytes: 0 };
  const incoming: Tally = { objects: 0, bytes: 0 };
  const tally = (repo: string) => repos.get(repo) ?? repos.set(repo, { objects: 0, bytes: 0 }).get(repo)!;

  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await lister.list(cursor);
    pages++;
    for (const { key, size } of page.objects) {
      if (key.startsWith(TRASH_PREFIX)) add(trash, size);
      else if (key.startsWith(INCOMING_PREFIX)) add(incoming, size);
      else if (key.startsWith(MEMBERS_PREFIX)) {
        const [owner, name, oid] = key.slice(MEMBERS_PREFIX.length).split("/");
        if (owner && name && oid) members.push({ repo: `${owner}/${name}`, oid });
      } else if (key.startsWith(SHARED_PREFIX)) {
        sharedSizes.set(key.slice(SHARED_PREFIX.length), size);
        add(total, size);
      } else if (key !== TOKENS_KEY && !key.startsWith("_")) {
        const [owner, name, oid, extra] = key.split("/");
        if (!owner || !name || !oid || extra !== undefined || !OID.test(oid)) continue;
        add(tally(`${owner}/${name}`), size);
        add(total, size);
      }
    }
    cursor = page.cursor;
  } while (cursor && pages < maxPages);

  if (layout === "shared") {
    for (const { repo, oid } of members) {
      const size = sharedSizes.get(oid);
      if (size !== undefined) add(tally(repo), size);
    }
  }
  const repositories = [...repos]
    .map(([repo, t]) => ({ repo, ...t }))
    .toSorted((a, b) => b.bytes - a.bytes || a.repo.localeCompare(b.repo));
  return { repositories, total, trash, incoming, truncated: cursor !== undefined };
}
