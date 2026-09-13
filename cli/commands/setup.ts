import { defineCommand } from "citty";

import { readDays } from "../app/common.ts";
import { setupServer } from "../app/setup.ts";
import * as compose from "../composition.ts";
import { bold } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";
import { commaList } from "./shared.ts";

export default defineCommand({
  meta: { name: "setup", description: "Create the bucket, its lock and trash rules, and deploy the server with Wrangler" },
  args: {
    owners: {
      type: "string",
      description: "GitHub users or orgs allowed to use the server, comma-separated",
      required: true,
      valueHint: "me,my-org",
    },
    name: { type: "string", description: "Worker name", default: "r2-lfs" },
    bucket: { type: "string", description: "R2 bucket name", default: "r2-lfs" },
    auth: { type: "enum", options: ["github", "token"], description: "How clients authenticate", default: "github" },
    layout: { type: "enum", options: ["per-repo", "shared"], description: "How objects are grouped in the bucket", default: "per-repo" },
    "lock-days": {
      type: "string",
      description: "Protect uploads from deletion for this many days; 0 to skip",
      default: "90",
      valueHint: "n",
    },
    "trash-days": { type: "string", description: "Expire trashed objects after this many days; 0 to skip", default: "30", valueHint: "n" },
    deploy: { type: "boolean", default: true, negativeDescription: "Only configure the bucket (for servers deployed with the button)" },
  },
  async run({ args }) {
    const term = new Terminal();
    term.intro("r2-lfs setup");
    const result = await setupServer(
      { wrangler: compose.wrangler, files: compose.files, reporter: term, workerBundle: compose.workerBundlePath() },
      {
        name: args.name,
        bucket: args.bucket,
        owners: commaList(args.owners),
        authMode: args.auth as "github" | "token",
        layout: args.layout as "per-repo" | "shared",
        lockDays: readDays("lock-days", args["lock-days"])!,
        trashDays: readDays("trash-days", args["trash-days"])!,
        deploy: args.deploy,
      },
    );

    const next = [
      `In each repository:  r2-lfs init --server ${result.url ?? "https://<your worker>.workers.dev"}`,
      "For gc, restore, token and presigned transfers, create an R2 API token with Object Read & Write",
      "on the bucket (R2 > Manage API tokens) and set R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.",
    ];
    term.note(next.join("\n"), "Next");
    term.outro(result.url ? `Deployed ${bold(result.url)}` : "Bucket configured");
  },
});
