import { TRASH_PREFIX } from "../../src/shared/contract.ts";
import { UsageError } from "../domain/errors.ts";
import type { StoredObject } from "../domain/objects.ts";
import { mergeFacts, type Planned, planObjects } from "../domain/plan.ts";
import type { Policy } from "../domain/policy.ts";
import { collectFacts, livePrefix, loadPolicy, type PolicyOverrides, resolveLayout } from "./common.ts";
import type { Bucket, GitRepository, LfsClient, Reporter } from "./ports.ts";

export interface GcDeps {
  repo: GitRepository;
  /** Shared layout only: every other repository that stores objects in the bucket. */
  otherRepos: GitRepository[];
  client: LfsClient;
  bucket: Bucket;
  reporter: Reporter;
}

export interface GcPlanOptions extends PolicyOverrides {
  fetch: boolean;
  layout?: string;
  now?: Date;
}

export interface GcPlan {
  prefix: string;
  policy: Policy;
  planned: Planned[];
  /** Objects gc would act on: to delete or to tier. */
  candidates: Planned[];
  /** Set when the plan cannot be trusted enough to apply without picking by hand. */
  sharedWithoutRepos: boolean;
}

export async function planGc(deps: GcDeps, opts: GcPlanOptions): Promise<GcPlan> {
  const { repo, client, bucket, reporter } = deps;
  const layout = await resolveLayout(client, opts.layout);
  if (layout === "per-repo" && deps.otherRepos.length > 0) throw new UsageError("--repos only applies to the shared layout");

  const policy = loadPolicy(repo, opts);
  const now = opts.now ?? new Date();
  const facts = await reporter.task(
    "Reading git history",
    () => {
      const repos = [repo, ...deps.otherRepos];
      if (opts.fetch) {
        for (const r of repos) if (!r.fetchAll()) reporter.warn(`git fetch failed in ${r.dir}; judging from the refs you already have`);
      }
      const merged = collectFacts(repo, policy, now);
      for (const other of deps.otherRepos) mergeFacts(merged, collectFacts(other, policy, now));
      return merged;
    },
    (f) => `${f.paths.size} objects known to history, ${f.tips.size} in branch and tag tips`,
  );

  const prefix = livePrefix(client, layout);
  const stored = await reporter.task(
    `Listing ${bucket.name}/${prefix}`,
    () => bucket.list(prefix),
    (s) => `${s.length} objects in ${bucket.name}/${prefix}`,
  );
  const planned = planObjects(stored, facts, policy, now);
  return {
    prefix,
    policy,
    planned,
    candidates: planned.filter((p) => p.decision.kind === "delete" || p.decision.kind === "tier"),
    sharedWithoutRepos: layout === "shared" && deps.otherRepos.length === 0,
  };
}

export type Outcome =
  | { key: string; action: "trashed" | "deleted" | "tiered"; ok: true }
  | { key: string; action: "trash" | "delete" | "tier"; ok: false; message: string };

/** Copies to the trash before deleting, so a refused delete never loses data. */
export async function trashObject(bucket: Bucket, object: StoredObject): Promise<Outcome> {
  const target = `${TRASH_PREFIX}${object.key}`;
  const copied = await bucket.copy(object.key, target);
  if (!copied.ok) return { key: object.key, action: "trash", ok: false, message: `copy failed: ${copied.status} ${copied.message}` };
  const deleted = await bucket.delete(object.key);
  if (!deleted.ok) {
    await bucket.delete(target);
    return { key: object.key, action: "trash", ok: false, message: `delete refused: ${deleted.status} ${deleted.message}` };
  }
  return { key: object.key, action: "trashed", ok: true };
}

export async function applyGc(
  deps: { bucket: Bucket; reporter: Reporter },
  chosen: Planned[],
  opts: { trash: boolean },
): Promise<Outcome[]> {
  const { bucket, reporter } = deps;
  const outcomes: Outcome[] = [];
  const bar = reporter.progress(chosen.length, "Applying");
  for (const item of chosen) {
    const key = item.object.key;
    if (item.decision.kind === "tier") {
      const result = await bucket.copy(key, key, "STANDARD_IA");
      outcomes.push(
        result.ok ? { key, action: "tiered", ok: true } : { key, action: "tier", ok: false, message: `${result.status} ${result.message}` },
      );
    } else if (opts.trash) {
      outcomes.push(await trashObject(bucket, item.object));
    } else {
      const result = await bucket.delete(key);
      outcomes.push(
        result.ok
          ? { key, action: "deleted", ok: true }
          : { key, action: "delete", ok: false, message: `${result.status} ${result.message}` },
      );
    }
    bar.advance(1, item.oid?.slice(0, 10));
  }
  bar.stop(`Applied ${chosen.length} changes`);
  return outcomes;
}
