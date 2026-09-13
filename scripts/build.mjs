// Bundles the CLI and the Worker into dist/ for the npm package.
// The Worker bundle lets `r2-lfs setup` deploy without a checkout of this repository.

import { chmodSync, readFileSync, rmSync } from "node:fs";

import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

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

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  platform: "neutral",
  format: "esm",
  target: "es2024",
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["module", "main"],
  legalComments: "linked",
});

console.log("built dist/cli.js and dist/worker.js");
