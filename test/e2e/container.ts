import { existsSync } from "node:fs";

/** These tests write to the global git config of whoever runs them, so they refuse to start outside the e2e container. */
export function assertInContainer(): void {
  const inContainer = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
  if (process.env.R2_LFS_E2E_CONTAINER !== "1" || !inContainer) {
    throw new Error("e2e tests change the global git config; run them in Docker with `pnpm test:e2e`");
  }
}

assertInContainer();
