import { defineCommand } from "citty";

import { SERVER_CONFIG_KEY } from "../app/init.ts";
import { migrate } from "../app/migrate.ts";
import * as compose from "../composition.ts";
import { UsageError } from "../domain/errors.ts";
import { PRESETS } from "../domain/presets.ts";
import { bold, red } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";
import { commaList } from "./shared.ts";

export default defineCommand({
  meta: { name: "migrate", description: "Copy every LFS version from GitHub LFS (or another server) to r2-lfs" },
  args: {
    server: {
      type: "string",
      description: "r2-lfs server origin (default: the one remembered by init)",
      valueHint: "https://r2-lfs.you.workers.dev",
    },
    from: { type: "string", description: "LFS endpoint to copy from (default: GitHub LFS for the remote)", valueHint: "url" },
    remote: { type: "string", description: "Remote to fetch from and push to", default: "origin" },
    repo: { type: "string", description: "owner/name to store objects under (default: from the remote)", valueHint: "owner/name" },
    track: { type: "string", description: `Presets (${Object.keys(PRESETS).join(", ")}) or patterns to track, comma-separated` },
    import: { type: "string", description: "Also move files committed without LFS into LFS, e.g. '*.blend,*.psd'", valueHint: "patterns" },
    "rewrite-history": { type: "boolean", description: "Confirm that --import may rewrite every commit" },
    commit: { type: "boolean", default: true, negativeDescription: "Leave .lfsconfig and .gitattributes uncommitted" },
    credential: { type: "enum", options: ["gh", "none"], description: "Answer git's password prompt with your gh login" },
  },
  async run({ args }) {
    const term = new Terminal();
    term.intro("r2-lfs migrate");
    const server = args.server ?? compose.gitConfig.get(SERVER_CONFIG_KEY);
    if (!server) throw new UsageError("pass --server with the origin of your r2-lfs server");

    const repo = compose.openRepo();
    const result = await migrate(
      { repo, gitConfig: compose.gitConfig, gh: compose.gh(repo.dir), reporter: term, connect: compose.connect },
      {
        server,
        remote: args.remote,
        track: commaList(args.track),
        importPatterns: commaList(args.import),
        rewriteHistory: Boolean(args["rewrite-history"]),
        commit: args.commit,
        ...(args.from ? { from: args.from } : {}),
        ...(args.repo ? { repo: args.repo } : {}),
        ...(args.credential ? { credential: args.credential as "gh" | "none" } : {}),
      },
    );

    const next = [result.rewroteHistory ? `git push --force-with-lease --all ${args.remote}` : `git push ${args.remote}`];
    if (!result.committed) next.unshift('git add .lfsconfig .gitattributes && git commit -m "Store LFS objects on r2-lfs"');
    term.note(next.join("\n"), "Next");
    if (result.missingAfterPush > 0) {
      term.outro(red(`${result.missingAfterPush} object(s) did not reach the server; run \`r2-lfs verify --all\` for details`));
      process.exitCode = 1;
    } else {
      term.outro(`Every version is on ${bold(result.url)}`);
    }
  },
});
