import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineCommand } from "citty";

import { archiveTag, DEFAULT_PART_BYTES } from "../app/archive.ts";
import * as compose from "../composition.ts";
import { UsageError } from "../domain/errors.ts";
import { formatBytes } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";

export default defineCommand({
  meta: { name: "archive", description: "Pack a tag, LFS files included, into tar parts and publish them as a GitHub release" },
  args: {
    tag: { type: "positional", description: "Tag to archive", required: true },
    output: { type: "string", description: "Directory for the tar parts (default: a temporary directory)", valueHint: "dir" },
    upload: { type: "boolean", default: true, negativeDescription: "Only write the tar parts" },
    "part-size": { type: "string", description: "Largest part in MiB (default: just under GitHub's 2 GiB asset limit)", valueHint: "MiB" },
    remote: { type: "string", description: "Remote to fetch LFS files from", default: "origin" },
  },
  async run({ args }) {
    const partBytes = args["part-size"] ? Number(args["part-size"]) * 1024 ** 2 : DEFAULT_PART_BYTES;
    if (!Number.isFinite(partBytes) || partBytes < 1024 ** 2) throw new UsageError("--part-size must be at least 1 MiB");

    const term = new Terminal();
    term.intro(`r2-lfs archive ${args.tag}`);
    const repo = compose.openRepo();
    const outputDir = args.output ?? join(tmpdir(), `r2-lfs-archive-${args.tag.replace(/[^\w.-]+/g, "-")}`);
    const result = await archiveTag(
      { repo, gh: compose.gh(repo.dir), files: compose.files, reporter: term },
      { tag: args.tag, outputDir, partBytes, upload: args.upload, remote: args.remote },
    );

    term.message(result.files.join("\n"));
    if (result.published) {
      term.note("Turn on Settings > General > Releases > Enable release immutability so no one can change it later.", "Tip");
      term.outro(`Published ${args.tag}: ${formatBytes(result.totalBytes)} in ${result.files.length - 1} part(s)`);
    } else {
      term.outro(`Wrote ${formatBytes(result.totalBytes)} to ${outputDir}`);
    }
  },
});
