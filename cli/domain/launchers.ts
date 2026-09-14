/**
 * git-lfs starts the transfer agent, and git the credential helper, from paths in git config. A path to Node and the CLI
 * breaks when a version manager moves or removes them, so git config points at small launchers instead: they prefer
 * `r2-lfs` on PATH and fall back to the Node and CLI they were installed with.
 */

export interface AgentTarget {
  node: string;
  cli: string;
}

export const LAUNCHER_MARKER = "Written by r2-lfs";

export function launcherFileName(platform: string): string {
  return platform === "win32" ? "transfer-agent.cmd" : "transfer-agent";
}

/** git runs credential helpers through its own sh, Git for Windows included. */
export const CREDENTIAL_LAUNCHER = "credential";

const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
// Git for Windows' sh reads C:/ paths.
const posix = (path: string) => path.replaceAll("\\", "/");

export function launcherScript(platform: string, target: AgentTarget): string {
  const missing = "r2-lfs is not on PATH and the Node or CLI it was installed with is gone; run `r2-lfs transfer-agent --install` again";
  if (platform === "win32") {
    return [
      "@echo off",
      `rem ${LAUNCHER_MARKER} transfer-agent --install. git-lfs starts it for multipart uploads.`,
      // Inside a batch file `%` starts a variable, even between quotes.
      `set "R2_LFS_NODE=${target.node.replaceAll("%", "%%")}"`,
      `set "R2_LFS_CLI=${target.cli.replaceAll("%", "%%")}"`,
      // A version manager's shim can be on PATH and still fail, so r2-lfs must answer before it is trusted.
      "call r2-lfs --version >nul 2>nul",
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
    `# ${LAUNCHER_MARKER} transfer-agent --install. git-lfs starts it for multipart uploads.`,
    `node=${shQuote(target.node)}`,
    `cli=${shQuote(target.cli)}`,
    // A version manager's shim can be on PATH and still fail, so r2-lfs must answer before it is trusted.
    "if r2-lfs --version >/dev/null 2>&1; then exec r2-lfs transfer-agent; fi",
    'if [ -x "$node" ] && [ -f "$cli" ]; then exec "$node" "$cli" transfer-agent; fi',
    `echo ${shQuote(missing)} >&2`,
    "exit 1",
    "",
  ].join("\n");
}

/**
 * The credential helper launcher. Without r2-lfs it answers with the gh login as older versions did, which the server also
 * accepts, so a removed install never leaves git asking for a password.
 */
export function credentialLauncherScript(target: AgentTarget): string {
  return [
    "#!/bin/sh",
    `# ${LAUNCHER_MARKER} credential --install. git runs it as the credential helper.`,
    `node=${shQuote(posix(target.node))}`,
    `cli=${shQuote(posix(target.cli))}`,
    'if r2-lfs --version >/dev/null 2>&1; then exec r2-lfs credential "$@"; fi',
    'if [ -f "$node" ] && [ -f "$cli" ]; then exec "$node" "$cli" credential "$@"; fi',
    'test "$1" = get && command -v gh >/dev/null 2>&1 && token=$(gh auth token) && echo username=r2-lfs && echo "password=$token"',
    "exit 0",
    "",
  ].join("\n");
}

/** How git config names the credential launcher: run with git's sh, from a path with forward slashes. */
export function credentialHelperCommand(launcher: string): string {
  return `!sh ${shQuote(posix(launcher))}`;
}

/** Whether a configured credential helper is the launcher `credentialHelperCommand` makes. */
export function isCredentialLauncherCommand(helper: string): boolean {
  return /^!sh '.*\/r2-lfs\/credential'$/.test(helper);
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
