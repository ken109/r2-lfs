import { defineCommand } from "citty";

import { initRepository, normalizeServer, SERVER_CONFIG_KEY } from "../app/init.ts";
import * as compose from "../composition.ts";
import { PRESETS } from "../domain/presets.ts";
import { bold } from "../ui/format.ts";
import { Terminal } from "../ui/terminal.ts";
import { commaList } from "./shared.ts";

export default defineCommand({
  meta: { name: "init", description: "Point this repository at an r2-lfs server" },
  args: {
    server: {
      type: "string",
      description: "Server origin, remembered in your git config for next time",
      valueHint: "https://r2-lfs.you.workers.dev",
    },
    repo: { type: "string", description: "owner/name to store objects under (default: from the origin remote)", valueHint: "owner/name" },
    track: { type: "string", description: `Presets (${Object.keys(PRESETS).join(", ")}) or patterns to track, comma-separated` },
    lockable: { type: "boolean", description: "Track them as lockable: read-only in checkouts until locked with git lfs lock" },
    credential: {
      type: "enum",
      options: ["gh", "none"],
      description: "Answer git's password prompt with your gh login (default: gh when possible)",
    },
  },
  async run({ args }) {
    const term = new Terminal();
    term.intro("r2-lfs init");
    const repo = compose.openRepo();

    const server =
      args.server ??
      compose.gitConfig.get(SERVER_CONFIG_KEY) ??
      (await term.text("URL of your r2-lfs server", {
        placeholder: "https://r2-lfs.<subdomain>.workers.dev",
        validate: (v) => {
          try {
            normalizeServer(v);
            return undefined;
          } catch (err) {
            return (err as Error).message;
          }
        },
      }));

    let track = commaList(args.track);
    if (track.length === 0 && term.interactive) {
      const preset = await term.select(
        "Track a preset of file types?",
        [
          { value: "", label: "No, I'll run git lfs track myself" },
          ...Object.entries(PRESETS).map(([name, patterns]) => ({ value: name, label: name, hint: patterns.slice(0, 5).join(" ") })),
        ],
        "",
      );
      if (preset) track = [preset];
    }

    const result = await initRepository(
      { repo, gitConfig: compose.gitConfig, gh: compose.gh(repo.dir), reporter: term, connect: compose.connect },
      {
        server,
        ...(args.repo ? { repo: args.repo } : {}),
        track,
        ...(args.lockable ? { lockable: true } : {}),
        ...(args.credential ? { credential: args.credential as "gh" | "none" } : {}),
      },
    );

    if (result.access === "unknown") {
      term.note(
        result.info.authMode === "github"
          ? "Git will ask for credentials on the first push. Use any username and a GitHub token as the password,\nor run `gh auth login` and then `r2-lfs init --credential gh`."
          : "Git will ask for credentials on the first push. Use any username and a token from `r2-lfs token create`.",
        "Credentials",
      );
    } else {
      term.success(`Signed in with ${result.access} access`);
    }
    term.note('git add .lfsconfig .gitattributes\ngit commit -m "Store LFS objects on r2-lfs"', "Next");
    term.outro(`Ready: ${bold(result.location.url)}`);
  },
});
