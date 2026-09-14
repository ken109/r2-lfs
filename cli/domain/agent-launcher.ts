/**
 * git-lfs starts the transfer agent from the path in git config. A path to Node and the CLI breaks when a version manager
 * moves or removes them, so git config points at a small launcher instead: it prefers `r2-lfs` on PATH and falls back to
 * the Node and CLI it was installed with.
 */

export interface AgentTarget {
  node: string;
  cli: string;
}

export const LAUNCHER_MARKER = "r2-lfs transfer-agent --install";

export function launcherFileName(platform: string): string {
  return platform === "win32" ? "transfer-agent.cmd" : "transfer-agent";
}

const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function launcherScript(platform: string, target: AgentTarget): string {
  const missing = "r2-lfs is not on PATH and the Node or CLI it was installed with is gone; run `r2-lfs transfer-agent --install` again";
  if (platform === "win32") {
    return [
      "@echo off",
      `rem Written by \`${LAUNCHER_MARKER}\`. git-lfs starts it for multipart uploads.`,
      // Inside a batch file `%` starts a variable, even between quotes.
      `set "R2_LFS_NODE=${target.node.replaceAll("%", "%%")}"`,
      `set "R2_LFS_CLI=${target.cli.replaceAll("%", "%%")}"`,
      "where r2-lfs >nul 2>nul",
      "if not errorlevel 1 goto path",
      'if not exist "%R2_LFS_NODE%" goto missing',
      'if not exist "%R2_LFS_CLI%" goto missing',
      '"%R2_LFS_NODE%" "%R2_LFS_CLI%" transfer-agent',
      "exit /b %errorlevel%",
      ":path",
      "call r2-lfs transfer-agent",
      "exit /b %errorlevel%",
      ":missing",
      `echo ${missing} 1>&2`,
      "exit /b 1",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `# Written by \`${LAUNCHER_MARKER}\`. git-lfs starts it for multipart uploads.`,
    `node=${shQuote(target.node)}`,
    `cli=${shQuote(target.cli)}`,
    "if command -v r2-lfs >/dev/null 2>&1; then exec r2-lfs transfer-agent; fi",
    'if [ -x "$node" ] && [ -f "$cli" ]; then exec "$node" "$cli" transfer-agent; fi',
    `echo ${shQuote(missing)} >&2`,
    "exit 1",
    "",
  ].join("\n");
}

/** The Node and CLI a launcher falls back to, or undefined when the text is not a launcher. */
export function parseLauncher(text: string): AgentTarget | undefined {
  if (!text.includes(LAUNCHER_MARKER)) return undefined;
  const sh = (name: string) => {
    const quoted = new RegExp(`^${name}='((?:[^']|'\\\\'')*)'$`, "m").exec(text)?.[1];
    return quoted?.replaceAll(`'\\''`, "'");
  };
  const cmd = (name: string) => new RegExp(`^set "${name}=(.*)"\\r?$`, "m").exec(text)?.[1]?.replaceAll("%%", "%");
  const node = sh("node") ?? cmd("R2_LFS_NODE");
  const cli = sh("cli") ?? cmd("R2_LFS_CLI");
  return node !== undefined && cli !== undefined ? { node, cli } : undefined;
}
