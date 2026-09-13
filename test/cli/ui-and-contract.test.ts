import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { lockPrefixes, workerConfig } from "../../cli/app/setup.ts";
import { displayWidth, formatBytes, table } from "../../cli/ui/format.ts";
import { VERSION, WORKER_COMPATIBILITY_DATE } from "../../src/shared/contract.ts";

describe("format", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
  });

  it("aligns columns by display width, counting CJK characters as two", () => {
    expect(displayWidth("日本")).toBe(4);
    const lines = table(
      ["name", "size"],
      [
        ["日本.blend", "1"],
        ["a.png", "10"],
      ],
      "_r",
    )
      // oxlint-disable-next-line no-control-regex -- strip colours for comparison.
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n");
    expect(lines).toEqual(["name        size", "日本.blend     1", "a.png         10"]);
  });
});

describe("contract", () => {
  it("keeps the CLI's deploy settings in step with wrangler.jsonc and package.json", () => {
    const wrangler = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    expect(wrangler).toContain(`"compatibility_date": "${WORKER_COMPATIBILITY_DATE}"`);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);

    // setup deploys the same defaults as the Deploy to Cloudflare button, apart from what its options choose.
    const jsonc = JSON.parse(wrangler.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")) as {
      observability: unknown;
      vars: Record<string, string>;
    };
    const config = workerConfig({
      name: "r2-lfs",
      bucket: jsonc.vars.R2_BUCKET_NAME!,
      owners: [],
      authMode: "github",
      layout: "per-repo",
      lockDays: 0,
      trashDays: 0,
      deploy: true,
    });
    expect(config.observability).toEqual(jsonc.observability);
    const { R2_ACCOUNT_ID: _account, ...deployedVars } = jsonc.vars;
    expect(config.vars).toEqual(deployedVars);
  });

  it("builds a Worker config that locks live prefixes but not the trash", () => {
    expect(lockPrefixes("per-repo", ["Acme", "me"])).toEqual(["acme/", "me/"]);
    expect(lockPrefixes("shared", ["acme"])).toEqual(["_shared/"]);
    const config = workerConfig({
      name: "lfs",
      bucket: "b",
      owners: ["acme"],
      authMode: "github",
      layout: "per-repo",
      lockDays: 90,
      trashDays: 30,
      deploy: true,
    });
    expect(config).toMatchObject({
      main: "worker.js",
      r2_buckets: [{ binding: "BUCKET", bucket_name: "b" }],
      vars: { ALLOWED_OWNERS: "acme" },
    });
  });
});
