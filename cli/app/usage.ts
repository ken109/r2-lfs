import { type BucketUsage, bucketUsage, type FileUsage, fileUsage } from "../domain/usage.ts";
import { livePrefix, presence, readHistory, resolveLayout, trashPrefix } from "./common.ts";
import type { ObjectStorage, GitRepository, LfsClient, Reporter } from "./ports.ts";

export interface UsageDeps {
  repo: GitRepository;
  client: LfsClient;
  reporter: Reporter;
  storage?: ObjectStorage;
}

export interface UsageReport {
  files: FileUsage[];
  objects: number;
  historyBytes: number;
  /** Present when the bucket could be listed. */
  bucket?: BucketUsage;
  /** False when the server was not asked which objects it has. */
  checkedServer: boolean;
}

export async function usageReport(deps: UsageDeps, opts: { offline: boolean; layout?: string }): Promise<UsageReport> {
  const { repo, client, reporter } = deps;
  const history = await reporter.task(
    "Reading LFS history",
    () => readHistory(repo),
    (h) => `${h.sizes.size} objects across ${h.versions.size} files`,
  );

  let state: Map<string, "stored" | "missing"> | undefined;
  if (!opts.offline) {
    const objects = [...history.sizes].map(([oid, size]) => ({ oid, size }));
    state = await reporter.task("Asking the server which objects it has", () => presence(client, objects));
  }

  let bucket: BucketUsage | undefined;
  if (deps.storage) {
    const layout = await resolveLayout(client, opts.layout);
    const store = deps.storage;
    bucket = await reporter.task("Listing the bucket", async () =>
      bucketUsage(history, await store.list(livePrefix(client, layout)), await store.list(trashPrefix(client, layout))),
    );
  }

  return {
    files: fileUsage(history, state),
    objects: history.sizes.size,
    historyBytes: [...history.sizes.values()].reduce((a, b) => a + b, 0),
    ...(bucket ? { bucket } : {}),
    checkedServer: state !== undefined,
  };
}
