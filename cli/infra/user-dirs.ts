import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { AgentTarget } from "../domain/launchers.ts";

/** Per-user files of r2-lfs, such as the transfer agent's launcher: $XDG_CONFIG_HOME/r2-lfs or ~/.config/r2-lfs. */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "r2-lfs");
}

/** Per-user caches of r2-lfs, such as short-lived tokens: $XDG_CACHE_HOME/r2-lfs or ~/.cache/r2-lfs. */
export function userCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "r2-lfs");
}

/** The Node and CLI this process runs, for a launcher to fall back to. */
export function currentCli(): AgentTarget {
  return { node: process.execPath, cli: resolve(process.argv[1] ?? "") };
}

export { join as joinPath };
