import { defineCommand } from "citty";

import { createToken, listTokens, revoke } from "../app/token.ts";
import * as compose from "../composition.ts";
import { UsageError } from "../domain/errors.ts";
import { table } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";
import { jsonArg } from "./shared.ts";

const create = defineCommand({
  meta: { name: "create", description: "Create a token for a server with AUTH_MODE=token (shown once)" },
  args: {
    scope: {
      type: "string",
      description: "Repositories it may use: owner/repo, with * within names (my-org/*, me/blender-*), or *",
      required: true,
    },
    label: { type: "string", description: "A name to recognise it by, such as laptop or ci", required: true },
    "read-only": { type: "boolean", description: "Allow downloads only" },
    admin: { type: "boolean", description: "Also allow unlocking files other people locked" },
    ...jsonArg,
  },
  async run({ args }) {
    const term = new Terminal({ quiet: args.json });
    if (args.admin && args["read-only"]) throw new UsageError("--admin and --read-only cannot be combined");
    const bucket = compose.bucket();
    term.intro("r2-lfs token create");
    const { token, entry } = await createToken(bucket, {
      label: args.label,
      scope: args.scope,
      permission: args.admin ? "admin" : args["read-only"] ? "read" : "write",
    });
    if (args.json) {
      const { sha256: _hash, ...rest } = entry;
      term.json({ ...rest, token });
      return;
    }
    term.note(token, "Token (it will not be shown again)");
    term.info(
      "Enter it as the password when git asks, or store it now:\nprintf 'protocol=https\\nhost=<server host>\\nusername=r2-lfs\\npassword=<token>\\n' | git credential approve",
    );
    term.outro(`Created ${entry.id}: ${entry.permission} access to ${entry.scope}. The server accepts it within 30 seconds.`);
  },
});

const list = defineCommand({
  meta: { name: "list", description: "List tokens" },
  args: { ...jsonArg },
  async run({ args }) {
    const term = new Terminal({ quiet: args.json });
    const bucket = compose.bucket();
    term.intro("r2-lfs token list");
    const tokens = await listTokens(bucket);
    if (args.json) {
      term.json(tokens);
      return;
    }
    if (tokens.length === 0) term.info("No tokens yet. Create one with `r2-lfs token create`.");
    else
      term.message(
        table(
          ["id", "label", "scope", "access", "created"],
          tokens.map((t) => [t.id, t.label, t.scope, t.permission, t.created.slice(0, 10)]),
        ),
      );
    term.outro(`${tokens.length} token(s)`);
  },
});

const revokeCommand = defineCommand({
  meta: { name: "revoke", description: "Revoke a token by id or label" },
  args: { token: { type: "positional", description: "id or label", required: true } },
  async run({ args }) {
    const term = new Terminal();
    const bucket = compose.bucket();
    term.intro("r2-lfs token revoke");
    const entry = await revoke(bucket, args.token);
    term.outro(`Revoked ${entry.id} (${entry.label}). The server stops accepting it within 30 seconds.`);
  },
});

export default defineCommand({
  meta: { name: "token", description: "Manage tokens for servers with AUTH_MODE=token" },
  subCommands: { create, list, revoke: revokeCommand },
});
