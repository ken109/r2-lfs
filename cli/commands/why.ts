import { relative, resolve, sep } from "node:path";

import { defineCommand } from "citty";

import { explain } from "../app/why.ts";
import * as compose from "../composition.ts";
import { bold, dim, formatBytes, formatDate, shortOid, table } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";
import { describeDecision, jsonArg, layoutArg } from "./shared.ts";

export default defineCommand({
  meta: { name: "why", description: "Explain where an LFS object is used and what gc would do with it" },
  args: {
    target: { type: "positional", description: "A file path, or an oid or its first characters", required: true },
    ...layoutArg,
    ...jsonArg,
  },
  async run({ args }) {
    const term = new Terminal({ quiet: args.json });
    term.intro("r2-lfs why");
    const repo = compose.openRepo();
    const bucket = compose.optionalBucket();
    // Paths are given relative to where the user stands; history stores them relative to the root.
    const asPath = relative(repo.dir, resolve(process.cwd(), args.target)).split(sep).join("/");
    const target = /^[0-9a-f]{6,64}$/.test(args.target) ? args.target : asPath;

    const result = await explain(
      { repo, client: compose.clientFor(repo), reporter: term, ...(bucket ? { bucket } : {}) },
      target,
      args.layout ? { layout: args.layout } : {},
    );

    if (args.json) {
      term.json(result);
      return;
    }
    if (result.path) term.step(`${bold(result.path)}: ${result.objects.length} version(s), newest first`);
    const rows = result.objects.map((o, i) => [
      String(i + 1),
      shortOid(o.oid),
      formatBytes(o.size),
      o.lastCommitted ? formatDate(o.lastCommitted) : "",
      o.uploaded ? `${formatDate(o.uploaded)}${o.storageClass === "STANDARD_IA" ? " (IA)" : ""}` : dim("?"),
      o.onServer ? describeDecision(o.decision) : o.inTrash ? "in the trash; r2-lfs restore can bring it back" : "missing on the server",
    ]);
    term.message(table(["#", "oid", "size", "committed", "uploaded", "status"], rows, "__r"));
    if (!result.path) term.info(`Paths: ${result.objects[0]?.paths.join(", ") || "(none in history)"}`);
    if (!bucket) term.info(dim("Set the R2_* variables to add upload dates and the trash."));
    term.outro("Done");
  },
});
