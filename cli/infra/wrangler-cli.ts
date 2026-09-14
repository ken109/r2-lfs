import type { Wrangler, WranglerLogin } from "../app/ports.ts";
import { runSync } from "./proc.ts";

/** Runs Wrangler through npx so the CLI does not need it installed. */
export class NpxWrangler implements Wrangler {
  run(args: string[], opts: { input?: string; cwd?: string } = {}): { code: number; output: string } {
    const result = runSync("npx", ["--yes", "wrangler@4", ...args], { input: opts.input, cwd: opts.cwd });
    return { code: result.code, output: `${result.stdout.toString()}${result.stderr}` };
  }

  whoami(env: NodeJS.ProcessEnv = process.env): WranglerLogin | undefined {
    // --json exits non-zero when not logged in, and keeps Wrangler's banner off stdout.
    const result = runSync("npx", ["--yes", "wrangler@4", "whoami", "--json"]);
    if (result.code !== 0) return undefined;
    return parseWhoami(result.stdout.toString(), env);
  }
}

export function parseWhoami(json: string, env: NodeJS.ProcessEnv): WranglerLogin | undefined {
  let info: { loggedIn?: boolean; email?: string; accounts?: { id?: string }[] };
  try {
    info = JSON.parse(json) as typeof info;
  } catch {
    return undefined;
  }
  if (info.loggedIn === false) return undefined;
  const accounts = (info.accounts ?? []).flatMap((a) => (typeof a.id === "string" ? [a.id] : []));
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || (accounts.length === 1 ? accounts[0] : undefined);
  return { email: info.email ?? "logged in", accountId };
}
