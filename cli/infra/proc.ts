import { spawn, spawnSync } from "node:child_process";

export class CommandError extends Error {
  override readonly name = "CommandError";
  readonly command: string;
  readonly code: number;
  readonly stderr: string;

  constructor(command: string, code: number, stderr: string) {
    super(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
    this.command = command;
    this.code = code;
    this.stderr = stderr;
  }
}

export interface RunOptions {
  cwd?: string;
  input?: string | Uint8Array;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

// npx is a .cmd shim on Windows, which only starts through a shell. Its arguments never contain spaces.
const needsShell = (cmd: string) => process.platform === "win32" && cmd === "npx";

export function runSync(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env ?? process.env,
    maxBuffer: 1024 * 1024 * 1024,
    shell: needsShell(cmd),
  });
  return {
    code: result.error ? 127 : (result.status ?? 1),
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.error ? String(result.error) : (result.stderr?.toString() ?? ""),
  };
}

/** Runs a command and returns stdout as text, throwing on a non-zero exit. */
export function output(cmd: string, args: string[], opts: RunOptions = {}): string {
  const result = runSync(cmd, args, opts);
  if (result.code !== 0) throw new CommandError([cmd, ...args].join(" "), result.code, result.stderr);
  return result.stdout.toString();
}

/** Runs a command attached to the terminal, for long operations whose progress the user should see. */
export function interactive(cmd: string, args: string[], opts: RunOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: "inherit", shell: needsShell(cmd) });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
