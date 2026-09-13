import { defineCommand } from "citty";

import { applyGc, planGc } from "../app/gc.ts";
import * as compose from "../composition.ts";
import { UsageError } from "../domain/errors.ts";
import type { Planned } from "../domain/plan.ts";
import { dim, formatBytes, formatDate, red, shortOid, table } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";
import { commaList, jsonArg, layoutArg } from "./shared.ts";

const size = (items: Planned[]) => formatBytes(items.reduce((s, p) => s + p.object.size, 0));

export default defineCommand({
  meta: { name: "gc", description: "Move LFS objects that no recent commit needs to the trash (dry run unless --apply)" },
  args: {
    apply: { type: "boolean", description: "Make the changes; without it gc only reports" },
    interactive: { type: "boolean", alias: "i", description: "Pick which candidates to act on" },
    trash: { type: "boolean", default: true, negativeDescription: "Delete immediately instead of moving to the trash" },
    fetch: { type: "boolean", default: true, negativeDescription: "Skip git fetch before reading refs" },
    "keep-days": { type: "string", description: "Override keep_days from .r2-lfs.toml (default 90)", valueHint: "n" },
    "keep-versions": { type: "string", description: "Override keep_versions (default 0)", valueHint: "n" },
    "min-age-days": { type: "string", description: "Override min_age_days (default 30)", valueHint: "n" },
    repos: { type: "string", description: "Shared layout: other clones that use the bucket, comma-separated", valueHint: "path,path" },
    ...layoutArg,
    ...jsonArg,
  },
  async run({ args }) {
    const term = new Terminal({ quiet: args.json });
    const acting = Boolean(args.apply || args.interactive);
    const bucket = compose.bucket();
    term.intro(acting ? "r2-lfs gc" : "r2-lfs gc (dry run)");

    const repo = compose.openRepo();
    const plan = await planGc(
      {
        repo,
        otherRepos: commaList(args.repos).map((dir) => compose.openRepo(dir)),
        client: compose.clientFor(repo),
        bucket,
        reporter: term,
      },
      {
        fetch: args.fetch,
        ...(args.layout ? { layout: args.layout } : {}),
        ...(args["keep-days"] ? { keepDays: args["keep-days"] } : {}),
        ...(args["keep-versions"] ? { keepVersions: args["keep-versions"] } : {}),
        ...(args["min-age-days"] ? { minAgeDays: args["min-age-days"] } : {}),
      },
    );

    if (plan.sharedWithoutRepos) {
      term.warn(
        "The bucket uses the shared layout. Objects that only other repositories need look unreferenced from here;\npass every repository that uses the bucket with --repos.",
      );
      if (args.apply && !args.interactive) throw new UsageError("refusing to --apply in the shared layout without --repos");
    }

    const by = (kind: string) => plan.planned.filter((p) => p.decision.kind === kind);
    const verb = args.trash ? "trash" : "delete";
    term.note(
      [
        `keep      ${by("keep").length} objects, ${size(by("keep"))}`,
        `too new   ${by("young").length} objects, ${size(by("young"))} ${dim(`(uploaded less than ${plan.policy.minAgeDays} days ago)`)}`,
        `tier      ${by("tier").length} objects, ${size(by("tier"))} ${dim("(to Infrequent Access)")}`,
        `${verb.padEnd(9)} ${by("delete").length} objects, ${size(by("delete"))}`,
        ...(by("foreign").length ? [`ignored   ${by("foreign").length} keys that are not LFS objects`] : []),
      ].join("\n"),
      "Plan",
    );

    const describe = (p: Planned) => [
      p.decision.kind === "tier" ? "tier" : verb,
      shortOid(p.oid ?? p.object.key),
      formatBytes(p.object.size),
      formatDate(p.object.lastModified),
      p.paths.join(", ") || dim("(not in history)"),
    ];
    if (plan.candidates.length > 0)
      term.message(table(["action", "oid", "size", "uploaded", "path"], plan.candidates.map(describe), "__rr"));

    let chosen = plan.candidates;
    if (args.interactive && chosen.length > 0) {
      const keys = await term.multiselect(
        "Which objects should gc act on?",
        plan.candidates.map((p) => ({ value: p.object.key, label: describe(p).slice(0, 3).join("  "), hint: p.paths.join(", ") })),
        plan.candidates.map((p) => p.object.key),
      );
      chosen = plan.candidates.filter((p) => keys.includes(p.object.key));
      if (chosen.length > 0 && !(await term.confirm(`Apply ${chosen.length} change(s), ${size(chosen)}?`))) chosen = [];
    }

    const report = (outcomes: unknown[] = []) =>
      term.json({
        prefix: plan.prefix,
        policy: plan.policy,
        plan: plan.planned.map((p) => ({
          key: p.object.key,
          size: p.object.size,
          uploaded: p.object.lastModified,
          paths: p.paths,
          decision: p.decision,
        })),
        outcomes,
      });

    if (!acting || chosen.length === 0) {
      if (args.json) report();
      term.outro(!acting && plan.candidates.length > 0 ? "Dry run. Re-run with --apply, or -i to pick." : "Nothing changed");
      return;
    }

    const outcomes = await applyGc({ bucket, reporter: term }, chosen, { trash: args.trash });
    if (args.json) report(outcomes);
    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length > 0) {
      term.warn(
        `${failed.length} change(s) were refused; a bucket lock rule may still protect them:\n${failed.map((f) => `${f.key}: ${f.ok ? "" : f.message}`).join("\n")}`,
      );
    }
    if (outcomes.some((o) => o.ok && o.action === "trashed"))
      term.info("`r2-lfs restore` brings trashed objects back until the trash rule expires them.");
    term.outro(failed.length ? red(`${outcomes.length - failed.length} applied, ${failed.length} refused`) : `${outcomes.length} applied`);
    if (failed.length) process.exitCode = 2;
  },
});
