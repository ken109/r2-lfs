import type { RepositoryIdentities } from "../app/ports.ts";
import type { Repo } from "../domain/repo.ts";
import { repositoryIdKey } from "../shared/contract.ts";

const TTL_MS = 60_000;
const MAX_ENTRIES = 1_000;
// Per isolate: the recorded id rarely changes, and only when an administrator deletes the record.
const recorded = new Map<string, { id: string; expires: number }>();

export function clearRepositoryIdentitiesCache(): void {
  recorded.clear();
}

/** Records the first id each repository name is used with as a small object in the bucket. */
export class R2RepositoryIdentities implements RepositoryIdentities {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async claim(repo: Repo, id: string): Promise<boolean> {
    const key = repositoryIdKey(repo.owner, repo.name);
    const hit = recorded.get(key);
    if (hit && hit.expires > Date.now()) return hit.id === id;

    let current = await this.bucket.get(key).then((object) => object?.text());
    if (current === undefined) {
      // R2 answers a failed precondition with null: someone recorded an id first, which is read back below.
      const written = await this.bucket.put(key, id, { onlyIf: new Headers({ "If-None-Match": "*" }) });
      current = written ? id : await this.bucket.get(key).then((object) => object?.text());
    }
    if (current === undefined) return false;
    if (recorded.size >= MAX_ENTRIES) recorded.clear();
    recorded.set(key, { id: current, expires: Date.now() + TTL_MS });
    return current === id;
  }
}
