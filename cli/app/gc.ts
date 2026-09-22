import { UsageError } from "../domain/errors.ts";
import { combinePlans, type Planned, planObjects } from "../domain/plan.ts";
import type { Policy } from "../domain/policy.ts";
import {
  collectFacts,
  livePrefix,
  loadPolicy,
  type PolicyOverrides,
  requireKeyIfEncrypted,
  requireSupport,
  resolveLayout,
} from "./common.ts";
import type { GitRepository, LfsClient, ObjectStorage, Outcome, Reporter } from "./ports.ts";

export interface GcDeps {
  repo: GitRepository;
  /** Shared layout only: every other repository that stores objects in the bucket. */
  otherRepos: GitRepository[];
  client: LfsClient;
  storage: ObjectStorage;
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
  const { client, storage, reporter } = deps;
  const layout = await resolveLayout(client, opts.layout);
  if (opts.mode !== "dry-run") await requireKeyIfEncrypted(client, storage);
  if (layout === "per-repo" && deps.otherRepos.length > 0) throw new UsageError("--repos only applies to the shared layout");
  if (layout === "shared") requireSupport(storage, "sharedLayout", "gc");
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
    `Listing ${storage.name}/${prefix}`,
    () => storage.list("live", layout),
    (s) => `${s.length} objects in ${storage.name}/${prefix}`,
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
  deps: { storage: ObjectStorage; reporter: Reporter },
  chosen: Planned[],
  opts: { trash: boolean },
): Promise<Outcome[]> {
  const { storage, reporter } = deps;
  if (!opts.trash) requireSupport(storage, "deleteWithoutTrash", "gc");
  const bar = reporter.progress(chosen.length, "Applying");
  const advance = (done: number) => bar.advance(done);
  const tiered = chosen.filter((p) => p.decision.kind === "tier").map((p) => p.object);
  const removed = chosen.filter((p) => p.decision.kind !== "tier").map((p) => p.object);
  const results = [
    ...(tiered.length > 0 ? await storage.tier(tiered, advance) : []),
    ...(removed.length === 0 ? [] : opts.trash ? await storage.trash(removed, advance) : await storage.delete(removed, advance)),
  ];
  bar.stop(`Applied ${chosen.length} changes`);
  const byKey = new Map(results.map((o) => [o.key, o]));
  return chosen.map((p) => byKey.get(p.object.key)!);
}
