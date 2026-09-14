import { defineCommand } from "citty";

import { diagnose } from "../app/doctor.ts";
import * as compose from "../composition.ts";
import { red } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";
import { jsonArg } from "./shared.ts";

export default defineCommand({
  meta: { name: "doctor", description: "Check that git-lfs, this repository and the server work together" },
  args: { ...jsonArg },
  async run({ args }) {
    const term = new Terminal({ quiet: args.json });
    term.intro("r2-lfs doctor");

    let repo: ReturnType<typeof compose.openRepo> | undefined;
    let openError: string | undefined;
    try {
      repo = compose.openRepo();
    } catch (err) {
      openError = (err as Error).message;
    }
    const checks = await diagnose({
      repo,
      ...(openError ? { openError } : {}),
      lfsInstalled: compose.gitLfsInstalled(),
      gitConfig: compose.gitConfig,
      gh: compose.gh(repo?.dir),
      connect: compose.connect,
      r2Configured: compose.r2Configured(),
      ghHelper: compose.ghCredentialHelper,
      readText: (path) => compose.files.readText(path),
      exists: (path) => compose.files.sizeOf(path) !== undefined,
      findOnPath: (command) => compose.findOnPath(command),
    });

    if (args.json) term.json(checks);
    for (const check of checks) {
      const line = check.fix ? `${check.name}: ${check.detail}\n→ ${check.fix}` : `${check.name}: ${check.detail}`;
      if (check.status === "ok") term.success(line);
      else if (check.status === "warn") term.warn(line);
      else term.error(line);
    }
    const failed = checks.filter((c) => c.status === "fail").length;
    const warned = checks.filter((c) => c.status === "warn").length;
    term.outro(failed ? red(`${failed} problem(s) to fix`) : warned ? `Works, with ${warned} warning(s)` : "All good");
    if (failed) process.exitCode = 1;
  },
});
