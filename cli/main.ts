import { defineCommand, runCommand, runMain } from "citty";

import { VERSION } from "../src/shared/contract.ts";
import { BatchRequestError, ConflictError } from "./app/ports.ts";
import { UsageError } from "./domain/errors.ts";
import { CommandError } from "./infra/proc.ts";
import { red } from "./ui/format.ts";

const main = defineCommand({
  meta: { name: "r2-lfs", version: VERSION, description: "Manage Git LFS objects stored on an r2-lfs server" },
  subCommands: {
    init: () => import("./commands/init.ts").then((m) => m.default),
    doctor: () => import("./commands/doctor.ts").then((m) => m.default),
    migrate: () => import("./commands/migrate.ts").then((m) => m.default),
    usage: () => import("./commands/usage.ts").then((m) => m.default),
    verify: () => import("./commands/verify.ts").then((m) => m.default),
    why: () => import("./commands/why.ts").then((m) => m.default),
    gc: () => import("./commands/gc.ts").then((m) => m.default),
    restore: () => import("./commands/restore.ts").then((m) => m.default),
    archive: () => import("./commands/archive.ts").then((m) => m.default),
    token: () => import("./commands/token.ts").then((m) => m.default),
    setup: () => import("./commands/setup.ts").then((m) => m.default),
    credential: () => import("./commands/credential.ts").then((m) => m.default),
  },
});

/** Errors the user can act on are printed as one message; anything else keeps its stack for bug reports. */
function report(err: unknown): number {
  if (err instanceof UsageError || err instanceof ConflictError) {
    console.error(red(`error: ${err.message}`));
    return 1;
  }
  if (err instanceof BatchRequestError) {
    const hint = err.status === 401 ? "\nThe server rejected your credentials; run `r2-lfs doctor`." : "";
    console.error(red(`error: the server refused the request (${err.status}): ${err.message}${hint}`));
    return 1;
  }
  if (err instanceof CommandError) {
    console.error(red(`error: ${err.message}`));
    return 1;
  }
  console.error(err);
  return 1;
}

const rawArgs = process.argv.slice(2);
const wantsHelp =
  rawArgs.length === 0 || rawArgs.some((a) => a === "--help" || a === "-h") || (rawArgs.length === 1 && rawArgs[0] === "--version");

if (wantsHelp) {
  // citty prints usage for the resolved sub command, or the version.
  await runMain(main, { rawArgs });
} else {
  try {
    await runCommand(main, { rawArgs });
  } catch (err) {
    // Argument mistakes get citty's usage text.
    if (err instanceof Error && err.name === "CLIError") {
      console.error(red(`error: ${err.message}`));
      console.error("Run with --help for usage.");
      process.exitCode = 1;
    } else {
      process.exitCode = report(err);
    }
  }
}
