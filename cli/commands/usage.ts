import { defineCommand } from "citty";

import { usageReport } from "../app/usage.ts";
import * as compose from "../composition.ts";
import { UsageError } from "../domain/errors.ts";
import { bold, dim, formatBytes, table } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";
import { jsonArg, layoutArg } from "./shared.ts";

export default defineCommand({
  meta: { name: "usage", description: "Show which files take up storage, counting every version" },
  args: {
    top: { type: "string", description: "How many files to list", default: "20", valueHint: "n" },
    offline: { type: "boolean", description: "Do not ask the server which objects it has" },
    ...layoutArg,
    ...jsonArg,
  },
  async run({ args }) {
    const top = Number(args.top);
    if (!Number.isInteger(top) || top < 1) throw new UsageError("--top must be a positive integer");
    const term = new Terminal({ quiet: args.json });
    term.intro("r2-lfs usage");
    const repo = compose.openRepo();
    const storage = args.offline ? undefined : await compose.optionalStorage(repo);
    const report = await usageReport(
      { repo, client: compose.clientFor(repo), reporter: term, ...(storage ? { storage } : {}) },
      { offline: Boolean(args.offline), ...(args.layout ? { layout: args.layout } : {}) },
    );

    if (args.json) {
      term.json(report);
      return;
    }

    const rows = report.files
      .slice(0, top)
      .map((f) => [
        f.path,
        String(f.versions),
        formatBytes(f.totalBytes),
        formatBytes(f.latestBytes),
        f.missing ? `${f.missing} missing` : "",
      ]);
    term.message(table(["file", "versions", "all versions", "latest", ""], rows, "_rrr"));
    if (report.files.length > top) term.message(dim(`… and ${report.files.length - top} more (--top ${report.files.length})`));

    const lines = [`${report.objects} objects in history, ${bold(formatBytes(report.historyBytes))}`];
    if (report.bucket) {
      const b = report.bucket;
      lines.push(
        `Bucket: ${formatBytes(b.storedBytes)} stored${b.infrequentAccessBytes ? `, ${formatBytes(b.infrequentAccessBytes)} of it in Infrequent Access` : ""}`,
      );
      if (b.orphanedBytes)
        lines.push(`${formatBytes(b.orphanedBytes)} is not referenced by any commit you have; \`r2-lfs gc\` can collect it`);
      if (b.trashBytes) lines.push(`${formatBytes(b.trashBytes)} in the trash, expiring on its own`);
      lines.push(`About $${b.monthlyUsd.toFixed(2)}/month before the 10 GB free tier`);
    } else {
      lines.push(
        dim("Push once so git has credentials for the server, or set the R2_* variables, to add bucket totals, orphans, trash and cost."),
      );
    }
    term.note(lines.join("\n"), "Totals");
    term.outro("Done");
  },
});
