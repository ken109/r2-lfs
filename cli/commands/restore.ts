import { defineCommand } from "citty";

import { listTrash, restoreObjects, type Selection, selectTrash } from "../app/restore.ts";
import * as compose from "../composition.ts";
import { UsageError } from "../domain/errors.ts";
import { formatBytes, formatDate, red, shortOid, table } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";
import { commaList, jsonArg, layoutArg } from "./shared.ts";

function selection(args: { oids?: string; path?: string; since?: string; all?: boolean }): Selection {
  const given = [args.oids, args.path, args.since, args.all || undefined].filter((v) => v !== undefined);
  if (given.length > 1) throw new UsageError("choose one of <oids>, --path, --since or --all");
  if (args.all) return { kind: "all" };
  if (args.path) return { kind: "path", path: args.path };
  if (args.since) {
    const date = new Date(`${args.since}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) throw new UsageError("--since must be a date like 2026-09-01");
    return { kind: "since", date };
  }
  if (args.oids) return { kind: "oids", prefixes: commaList(args.oids) };
  throw new UsageError("say what to restore: <oids>, --path, --since or --all (or --list to look first)");
}

export default defineCommand({
  meta: { name: "restore", description: "Bring objects back from the trash" },
  args: {
    oids: { type: "positional", description: "Oids or their first characters, comma-separated", required: false },
    path: { type: "string", description: "Restore every trashed version of this file" },
    since: { type: "string", description: "Restore everything trashed on or after this date", valueHint: "YYYY-MM-DD" },
    all: { type: "boolean", description: "Restore everything in this repository's trash" },
    list: { type: "boolean", description: "Only list what is in the trash" },
    ...layoutArg,
    ...jsonArg,
  },
  async run({ args }) {
    const term = new Terminal({ quiet: args.json });
    const bucket = compose.bucket();
    term.intro("r2-lfs restore");
    const repo = compose.openRepo();
    const deps = { repo, client: compose.clientFor(repo), bucket, reporter: term };
    const trash = await listTrash(deps, args.layout);

    if (args.list) {
      if (args.json) term.json(trash.map((t) => ({ oid: t.oid, size: t.object.size, trashed: t.object.lastModified, paths: t.paths })));
      else if (trash.length > 0) {
        term.message(
          table(
            ["oid", "size", "trashed", "path"],
            trash.map((t) => [shortOid(t.oid), formatBytes(t.object.size), formatDate(t.object.lastModified), t.paths.join(", ")]),
            "_r",
          ),
        );
      }
      term.outro(`${trash.length} object(s) in the trash`);
      return;
    }

    const selected = selectTrash(trash, selection(args));
    if (selected.length === 0) {
      if (args.json) term.json([]);
      term.outro("Nothing in the trash matches");
      return;
    }
    const outcomes = await restoreObjects({ bucket, reporter: term }, selected);
    if (args.json) term.json(outcomes);
    for (const o of outcomes) if (o.message) (o.ok ? term.warn : term.error).call(term, `${shortOid(o.oid)}: ${o.message}`);
    const failed = outcomes.filter((o) => !o.ok).length;
    term.outro(failed ? red(`${outcomes.length - failed} restored, ${failed} failed`) : `${outcomes.length} restored`);
    if (failed) process.exitCode = 1;
  },
});
