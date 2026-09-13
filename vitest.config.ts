import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: { name: "worker", include: ["test/worker/**/*.test.ts"] },
      },
      {
        // CLI tests drive real git processes, which start slowly on Windows runners.
        test: { name: "cli", include: ["test/cli/**/*.test.ts"], environment: "node", testTimeout: 30_000 },
      },
    ],
  },
});
