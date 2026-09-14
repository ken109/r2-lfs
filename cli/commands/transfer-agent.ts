import { defineCommand } from "citty";

import { inNpxCache, installTransferAgent, runTransferAgent } from "../app/transfer-agent.ts";
import * as compose from "../composition.ts";

export default defineCommand({
  meta: {
    name: "transfer-agent",
    description: "A git-lfs custom transfer agent that uploads in resumable parts, past the Worker's request limit",
  },
  args: {
    install: { type: "boolean", description: "Register this command with git-lfs in your git config" },
  },
  async run({ args }) {
    if (args.install) {
      const { deps, target } = compose.launcherInstall();
      const launcher = installTransferAgent(deps, target);
      console.error(`git-lfs now offers r2-lfs servers multipart uploads, through ${launcher}`);
      if (inNpxCache(target.cli) && !compose.findOnPath("r2-lfs")) {
        console.error("This r2-lfs runs from npx's cache, which npm clears; install it globally so the launcher keeps finding it.");
      }
      return;
    }
    const deps = {
      uploads: compose.multipartUploads(),
      states: compose.uploadStates(),
      readPart: compose.readFileRange,
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    };
    // git-lfs reads the answers from stdout, so nothing else may be printed there.
    const lines = compose.stdinLines();
    await runTransferAgent(deps, lines, (message) => process.stdout.write(`${JSON.stringify(message)}\n`));
    lines.close();
  },
});
