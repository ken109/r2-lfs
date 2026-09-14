import { defineCommand } from "citty";

import { forgetSession, installCredentialHelper, parseCredentialRequest, passwordFor } from "../app/credential.ts";
import * as compose from "../composition.ts";
import { UsageError } from "../domain/errors.ts";
import { parseLfsUrl } from "../domain/remote.ts";

export default defineCommand({
  meta: {
    name: "credential",
    description: "A git credential helper: R2_LFS_TOKEN, an Actions OIDC token, or your gh login traded for a short-lived token",
  },
  args: {
    operation: { type: "positional", description: "get, store or erase, as git calls it", required: false },
    install: { type: "boolean", description: "Register this command as git's credential helper for the server" },
    server: { type: "string", description: "Server origin for --install (default: this repository's lfs.url)", valueHint: "https://..." },
  },
  async run({ args }) {
    if (args.install) {
      const raw = args.server ?? compose.openRepo().lfsUrl();
      const origin = raw ? new URL(raw).origin : undefined;
      if (!origin) throw new UsageError("pass --server, or run inside a repository with an lfs.url");
      const { deps, target } = compose.launcherInstall();
      installCredentialHelper(deps, target, origin);
      console.error(`git now asks r2-lfs for credentials for ${origin}`);
      return;
    }
    // git sends the request on stdin and reads the answer from stdout, so nothing else may be printed there.
    if (args.operation !== "get" && args.operation !== "erase") return;
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    const fields = parseCredentialRequest(input);
    const protocol = fields.get("protocol");
    const host = fields.get("host");
    if (!protocol || !host || !parseLfsUrl(`${protocol}://${host}/o/r`)) return;
    const origin = `${protocol}://${host}`;
    const sessions = compose.sessionCache();
    if (args.operation === "erase") {
      forgetSession(sessions, origin, fields.get("path"));
      return;
    }
    const deps = {
      token: process.env.R2_LFS_TOKEN,
      actions: compose.actionsIdTokens(),
      connect: compose.connect,
      ghToken: () => compose.gh().token(),
      sessions,
      now: () => new Date(),
    };
    const password = await passwordFor(deps, origin, fields.get("path"));
    if (password) process.stdout.write(`username=r2-lfs\npassword=${password}\n`);
  },
});
