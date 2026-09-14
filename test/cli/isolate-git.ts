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
// CI images install the LFS filter in the system config, where checkouts of pointer files would try to
// download objects no server has.
process.env.GIT_LFS_SKIP_SMUDGE = "1";

afterAll(() => rmSync(dir, { recursive: true, force: true }));
