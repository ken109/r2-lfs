import type { GlobalGitConfig } from "../app/ports.ts";
import { output, runSync } from "./proc.ts";

/** A credential helper that answers with the current `gh` login, so no token is ever pasted. */
export const GH_CREDENTIAL_HELPER = '!f() { test "$1" = get && echo username=r2-lfs && echo "password=$(gh auth token)"; }; f';

export class UserGitConfig implements GlobalGitConfig {
  get(key: string): string | undefined {
    const result = runSync("git", ["config", "--global", "--get", key]);
    return result.code === 0 ? result.stdout.toString().trim() || undefined : undefined;
  }

  set(key: string, value: string): void {
    output("git", ["config", "--global", key, value]);
  }

  helpersFor(origin: string): string[] {
    const result = runSync("git", ["config", "--get-all", `credential.${origin}.helper`]);
    return result.code === 0 ? result.stdout.toString().split("\n").filter(Boolean) : [];
  }

  useGhCredentials(origin: string): void {
    const key = `credential.${origin}.helper`;
    // An empty helper first resets helpers inherited from other config files, such as a keychain.
    output("git", ["config", "--global", "--replace-all", key, ""]);
    output("git", ["config", "--global", "--add", key, GH_CREDENTIAL_HELPER]);
  }

  credentialFor(origin: string): string | undefined {
    if (process.env.R2_LFS_TOKEN) return process.env.R2_LFS_TOKEN;
    const url = new URL(origin);
    const result = runSync("git", ["credential", "fill"], {
      input: `protocol=${url.protocol.replace(":", "")}\nhost=${url.host}\n\n`,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" },
    });
    if (result.code !== 0) return undefined;
    return /^password=(.*)$/m.exec(result.stdout.toString())?.[1] || undefined;
  }
}
