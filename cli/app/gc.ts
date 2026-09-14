import { TRASH_PREFIX } from "../../src/shared/contract.ts";
import { UsageError } from "../domain/errors.ts";
import type { StoredObject } from "../domain/objects.ts";
import { combinePlans, type Planned, planObjects } from "../domain/plan.ts";
import type { Policy } from "../domain/policy.ts";
import { collectFacts, livePrefix, loadPolicy, type PolicyOverrides, requireKeyIfEncrypted, resolveLayout } from "./common.ts";
import type { Bucket, GitRepository, LfsClient, Reporter } from "./ports.ts";

export interface GcDeps {
  repo: GitRepository;
  /** Shared layout only: every other repository that stores objects in the bucket. */
  otherRepos: GitRepository[];
  client: LfsClient;
  bucket: Bucket;
  reporter: Reporter;
}

export type GcMode = "dry-run" | "apply" | "interactive";

/** What the gc flags ask for. Anything but a dry run turns on the checks that protect the bucket. */
export function gcMode(flags: { apply?: boolean; interactive?: boolean }): GcMode {
  if (flags.interactive) return "interactive";
  return flags.apply ? "apply" : "dry-run";
}

export interface GcPlanOptions extends PolicyOverrides {
  fetch: boolean;
  /** Whether the plan will be applied; changing the bucket needs refs that are known to be current. */
  mode: GcMode;
  layout?: string;
  now?: Date;
}

export interface GcPlan {
  prefix: string;
  /** The policy of the repository gc runs in; other repositories are judged by their own. */
  policy: Policy;
  planned: Planned[];
  /** Objects gc would act on: to delete or to tier. */
  candidates: Planned[];
  /** Set when the plan cannot be trusted enough to apply without picking by hand. */
  sharedWithoutRepos: boolean;
  /** The ref tips the plan was made from, to notice pushes that land before it is applied. */
  refs: string;
}

const refsOf = (repos: readonly GitRepository[]) => repos.map((r) => r.refTips().toSorted().join(",")).join("|");

export async function planGc(deps: GcDeps, opts: GcPlanOptions): Promise<GcPlan> {
  const { client, bucket, reporter } = deps;
  const layout = await resolveLayout(client, opts.layout);
  if (opts.mode !== "dry-run") await requireKeyIfEncrypted(client, bucket);
  if (layout === "per-repo" && deps.otherRepos.length > 0) throw new UsageError("--repos only applies to the shared layout");
  const sharedWithoutRepos = layout === "shared" && deps.otherRepos.length === 0;
  if (sharedWithoutRepos && opts.mode === "apply") {
    throw new UsageError("refusing to --apply in the shared layout without --repos; pick objects with -i or pass every repository");
  }

  const repos = [deps.repo, ...deps.otherRepos];
  for (const r of repos) {
    const gaps = r.historyGaps();
    // Objects only the missing commits use would look unreferenced.
    if (gaps.length > 0) throw new UsageError(`gc needs the full history of ${r.dir}, but ${gaps.join("; ")}`);
  }

  // Each repository is judged by its own .r2-lfs.toml.
  const views = repos.map((r) => ({ repo: r, policy: loadPolicy(r, opts) }));
  const now = opts.now ?? new Date();
  const acting = opts.mode !== "dry-run";
  const facts = await reporter.task(
    "Reading git history",
    () => {
      if (opts.fetch) {
        for (const r of repos) {
          if (r.fetchAll()) continue;
          if (acting) throw new UsageError(`git fetch failed in ${r.dir}; fix it, or pass --no-fetch to judge from the refs you have`);
          reporter.warn(`git fetch failed in ${r.dir}; judging from the refs you already have`);
        }
      }
      return { refs: refsOf(repos), all: views.map((v) => collectFacts(v.repo, v.policy, now)) };
    },
    ({ all }) => {
      const known = new Set(all.flatMap((f) => [...f.paths.keys()]));
      const tips = new Set(all.flatMap((f) => [...f.tips]));
      return `${known.size} objects known to history, ${tips.size} in branch and tag tips`;
    },
  );

  const prefix = livePrefix(client, layout);
  const stored = await reporter.task(
    `Listing ${bucket.name}/${prefix}`,
    () => bucket.list(prefix),
    (s) => `${s.length} objects in ${bucket.name}/${prefix}`,
  );
  const planned = combinePlans(views.map((v, i) => planObjects(stored, facts.all[i]!, v.policy, now)));
  return {
    prefix,
    policy: views[0]!.policy,
    planned,
    candidates: planned.filter((p) => p.decision.kind === "delete" || p.decision.kind === "tier"),
    sharedWithoutRepos,
    refs: facts.refs,
  };
}

/**
 * Fetches again right before applying. If refs moved since the plan was made, for example because someone
 * pushed a revert to an old version while candidates were being picked, drops what the new refs need.
 */
export async function recheckPlan(deps: GcDeps, plan: GcPlan, chosen: Planned[], opts: GcPlanOptions): Promise<Planned[]> {
  if (!opts.fetch || chosen.length === 0) return chosen;
  const repos = [deps.repo, ...deps.otherRepos];
  for (const r of repos) {
    if (!r.fetchAll()) throw new UsageError(`git fetch failed in ${r.dir}; nothing was changed`);
  }
  if (refsOf(repos) === plan.refs) return chosen;

  const fresh = await planGc(deps, { ...opts, fetch: false });
  const still = new Set(fresh.candidates.map((p) => `${p.object.key} ${p.decision.kind}`));
  const kept = chosen.filter((p) => still.has(`${p.object.key} ${p.decision.kind}`));
  if (kept.length < chosen.length) {
    deps.reporter.warn(`${chosen.length - kept.length} object(s) are needed by commits pushed since the plan was made; leaving them alone`);
  }
  return kept;
}

export type Outcome =
  | { key: string; action: "trashed" | "deleted" | "tiered"; ok: true }
  /** A bucket lock rule still protects the object; a later gc collects it. */
  | { key: string; action: "locked"; ok: true }
  | { key: string; action: "trash" | "delete" | "tier"; ok: false; message: string };

/** Copies to the trash before deleting, so a refused delete never loses data. */
export async function trashObject(bucket: Bucket, object: StoredObject): Promise<Outcome> {
  const key = object.key;
  const target = `${TRASH_PREFIX}${key}`;
  const copied = await bucket.copy(key, target);
  if (!copied.ok) return { key, action: "trash", ok: false, message: `copy failed: ${copied.status} ${copied.message}` };
  const deleted = await bucket.delete(key);
  if (deleted.ok) return { key, action: "trashed", ok: true };
  if (deleted.locked) {
    await bucket.delete(target);
    return { key, action: "locked", ok: true };
  }

  // An error response does not prove nothing was deleted, as with a timeout, so drop the copy only when the object is still there.
  const refused = `delete refused: ${deleted.status} ${deleted.message}`;
  let stillThere: boolean;
  try {
    stillThere = await bucket.exists(key);
  } catch {
    return { key, action: "trash", ok: false, message: `${refused}; kept the trash copy because the object could not be checked` };
  }
  if (!stillThere) return { key, action: "trashed", ok: true };
  await bucket.delete(target);
  return { key, action: "trash", ok: false, message: refused };
}

/** Checks the refs once more, then applies what is still a candidate. The only way the gc command changes the bucket. */
export async function applyPlan(
  deps: GcDeps,
  plan: GcPlan,
  chosen: Planned[],
  opts: GcPlanOptions & { trash: boolean },
): Promise<Outcome[]> {
  const current = await recheckPlan(deps, plan, chosen, opts);
  return applyGc(deps, current, { trash: opts.trash });
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
        result.ok
          ? { key, action: "tiered", ok: true }
          : result.locked
            ? { key, action: "locked", ok: true }
            : { key, action: "tier", ok: false, message: `${result.status} ${result.message}` },
      );
    } else if (opts.trash) {
      outcomes.push(await trashObject(bucket, item.object));
    } else {
      const result = await bucket.delete(key);
      outcomes.push(
        result.ok
          ? { key, action: "deleted", ok: true }
          : result.locked
            ? { key, action: "locked", ok: true }
            : { key, action: "delete", ok: false, message: `${result.status} ${result.message}` },
      );
    }
    bar.advance(1, item.oid?.slice(0, 10));
  }
  bar.stop(`Applied ${chosen.length} changes`);
  return outcomes;
}
