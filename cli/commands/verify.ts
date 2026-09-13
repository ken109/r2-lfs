import { defineCommand } from "citty";

import { verifyObjects } from "../app/verify.ts";
import * as compose from "../composition.ts";
import { formatBytes, red, shortOid, table } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";
import { jsonArg, layoutArg } from "./shared.ts";

export default defineCommand({
  meta: { name: "verify", description: "Check that the server has every LFS object your branches and tags need" },
  args: {
    all: { type: "boolean", description: "Check every version in history, not only branch and tag tips" },
    deep: { type: "boolean", description: "Download each object and check its SHA-256" },
    ...layoutArg,
    ...jsonArg,
  },
  async run({ args }) {
    const term = new Terminal({ quiet: args.json });
    term.intro("r2-lfs verify");
    const repo = compose.openRepo();
    const bucket = compose.optionalBucket();
    const result = await verifyObjects(
      { repo, client: compose.clientFor(repo), reporter: term, ...(bucket ? { bucket } : {}) },
      { all: Boolean(args.all), deep: Boolean(args.deep), ...(args.layout ? { layout: args.layout } : {}) },
    );

    if (args.json) term.json(result);
    if (result.missing.length > 0) {
      const rows = result.missing.map((m) => [shortOid(m.oid), formatBytes(m.size), m.paths.join(", "), m.inTrash ? "in trash" : ""]);
      term.error(
        `${result.missing.length} of ${result.checked} objects are missing on the server\n${table(["oid", "size", "path", ""], rows, "_r")}`,
      );
      if (result.missing.some((m) => m.inTrash)) term.info("Bring trashed objects back with `r2-lfs restore <oid>`.");
      else term.info("If you still have them locally, `git lfs push --all origin` uploads them again.");
    } else {
      term.success(`All ${result.checked} objects are on the server`);
    }
    if (result.corrupt.length > 0)
      term.error(`${result.corrupt.length} objects do not match their SHA-256: ${result.corrupt.map(shortOid).join(", ")}`);

    const failed = result.missing.length > 0 || result.corrupt.length > 0;
    term.outro(failed ? red("Verification failed") : "Verified");
    if (failed) process.exitCode = 1;
  },
});
