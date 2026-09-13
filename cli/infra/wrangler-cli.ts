import type { Wrangler } from "../app/ports.ts";
import { runSync } from "./proc.ts";

/** Runs Wrangler through npx so the CLI does not need it installed. */
export class NpxWrangler implements Wrangler {
  run(args: string[], opts: { input?: string; cwd?: string } = {}): { code: number; output: string } {
    const result = runSync("npx", ["--yes", "wrangler@4", ...args], { input: opts.input, cwd: opts.cwd });
    return { code: result.code, output: `${result.stdout.toString()}${result.stderr}` };
  }

  whoami(): string | undefined {
    const result = this.run(["whoami"]);
    if (result.code !== 0 || /not authenticated/i.test(result.output)) return undefined;
    return /associated with the email (\S+)/i.exec(result.output)?.[1] ?? "logged in";
  }
}
