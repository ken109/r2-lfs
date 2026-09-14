// Builds the npm package: the CLI, and the Worker Vite built for `r2-lfs setup` to deploy without a checkout.
// Run after `vite build`, which writes dist/server (the Worker) and dist/client (the admin UI's files).

import { chmodSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";

import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

if (!existsSync("dist/server/index.js")) throw new Error("run `vite build` first; dist/server/index.js is missing");
for (const old of ["dist/cli.js", "dist/cli.js.LEGAL.txt", "dist/worker.js", "dist/worker.js.LEGAL.txt", "dist/worker", "dist/public"])
  rmSync(old, { recursive: true, force: true });

await build({
  entryPoints: ["cli/main.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: `node${pkg.engines.node.replace(/[^\d.]/g, "")}`,
  banner: { js: "#!/usr/bin/env node" },
  // Lazy command imports stay in one file; the CLI is small enough.
  splitting: false,
  legalComments: "linked",
});
chmodSync("dist/cli.js", 0o755);

// The generated dist/server/wrangler.json holds paths of this machine; setup writes its own.
cpSync("dist/server", "dist/worker", { recursive: true, filter: (src) => !/wrangler\.json$|[\\/]\.vite$/.test(src) });
cpSync("dist/client", "dist/public", { recursive: true });

console.log("built dist/cli.js, dist/worker and dist/public");
