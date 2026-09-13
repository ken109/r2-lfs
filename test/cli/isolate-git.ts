import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

// git in these tests reads an empty global config, so settings on the developer's machine, such as
// fetch.pruneTags or core.hooksPath, cannot change results. Tests never write the global config;
// those that do belong in test/e2e.
const dir = mkdtempSync(join(tmpdir(), "r2-lfs-gitconfig-"));
const config = join(dir, "config");
writeFileSync(config, "");
process.env.GIT_CONFIG_GLOBAL = config;

afterAll(() => rmSync(dir, { recursive: true, force: true }));
