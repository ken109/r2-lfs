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
        test: {
          name: "cli",
          include: ["test/cli/**/*.test.ts"],
          setupFiles: ["test/cli/isolate-git.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
      // Changes the global git config and runs wrangler dev, so it exists only inside test/e2e/Dockerfile.
      ...(process.env.R2_LFS_E2E_CONTAINER === "1"
        ? [
            {
              test: {
                name: "e2e",
                include: ["test/e2e/**/*.test.ts"],
                setupFiles: ["test/e2e/container.ts"],
                environment: "node",
                testTimeout: 120_000,
                hookTimeout: 120_000,
                fileParallelism: false,
              },
            },
          ]
        : []),
    ],
  },
});
