import { describe, expect, it } from "vitest";

import { usageReport } from "../../cli/app/usage.ts";
import { verifyObjects } from "../../cli/app/verify.ts";
import { explain } from "../../cli/app/why.ts";
import { UsageError } from "../../cli/domain/errors.ts";
import { BucketStorage } from "../../cli/infra/bucket-storage.ts";
import { Git } from "../../cli/infra/git.ts";
import {
  cleanups,
  FakeLfsClient,
  MemoryBucket,
  pointerText,
  REPOSITORY,
  scenario,
  scenarioDeps,
  SilentReporter,
  TempRepo,
} from "./helpers.ts";

const cleanup = cleanups();

describe("verify, usage and why", () => {
  it("reports what the server is missing and whether it is in the trash", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    s.client.stored.delete(s.newOid);
    await s.bucket.copy(`${s.prefix}${s.newOid}`, `_trash/${s.prefix}${s.newOid}`);
    const result = await verifyObjects(scenarioDeps(s), { all: false, deep: true });
    expect(result.checked).toBe(2);
    expect(result.missing).toEqual([{ oid: s.newOid, size: 7, paths: ["hero.blend"], inTrash: true }]);
    expect(result.corrupt).toEqual([s.texOid]);
  });

  it("totals every version per file", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    const report = await usageReport(scenarioDeps(s), { offline: false });
    expect(report.files[0]).toMatchObject({ path: "hero.blend", versions: 2, totalBytes: 14 });
    expect(report.bucket?.orphanedBytes).toBe(6);
  });

  it("explains a path version by version", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    const deps = scenarioDeps(s);
    expect((await explain(deps, "hero.blend")).objects.map((o) => [o.oid, o.decision.kind])).toEqual([
      [s.newOid, "keep"],
      [s.oldOid, "keep"],
    ]);
    s.repo.write(".r2-lfs.toml", "keep_days = 90\n");
    expect((await explain(deps, "hero.blend")).objects.map((o) => [o.oid, o.decision.kind])).toEqual([
      [s.newOid, "keep"],
      [s.oldOid, "delete"],
    ]);
    await expect(explain({ repo: s.git, client: s.client, reporter: new SilentReporter() }, "nothing.txt")).rejects.toThrow(UsageError);
  });

  it("explains an object by oid prefix, and without bucket access judges it as if uploaded long ago", async () => {
    const repo = new TempRepo();
    cleanup(() => repo.remove());
    const first = `abcdef${"1".repeat(58)}`;
    const second = `abcdef${"2".repeat(58)}`;
    repo.write("one.bin", pointerText(first, 5));
    repo.write("two.bin", pointerText(second, 5));
    repo.commit("objects", 200);
    repo.write("one.bin", pointerText("c".repeat(64), 5));
    repo.write("two.bin", pointerText("d".repeat(64), 5));
    repo.commit("replaced");
    repo.write(".r2-lfs.toml", "keep_days = 90\n");

    const client = new FakeLfsClient();
    client.stored.set(first, "x");
    const bucket = new MemoryBucket();
    bucket.seed(`acme/assets/${first}`, { ageDays: 2 });
    bucket.seed(`_trash/acme/assets/${second}`);
    const deps = { repo: Git.open(repo.dir), client, reporter: new SilentReporter() };

    await expect(explain(deps, "abcdef")).rejects.toThrow(/abcdef is ambiguous/);
    await expect(explain(deps, "abcdef9")).rejects.toThrow(/no LFS object in history starts with abcdef9/);

    const withBucket = await explain({ ...deps, storage: new BucketStorage(bucket, REPOSITORY) }, "abcdef1");
    expect(withBucket.path).toBeUndefined();
    expect(withBucket.objects).toEqual([
      expect.objectContaining({
        oid: first,
        paths: ["one.bin"],
        onServer: true,
        inTrash: false,
        uploaded: expect.any(Date),
        decision: { kind: "young" },
      }),
    ]);
    const withoutBucket = await explain(deps, "abcdef1");
    expect(withoutBucket.objects[0]).toMatchObject({ onServer: true, decision: { kind: "delete" } });
    expect(withoutBucket.objects[0]?.uploaded).toBeUndefined();
    expect((await explain({ ...deps, storage: new BucketStorage(bucket, REPOSITORY) }, "abcdef2")).objects[0]).toMatchObject({
      onServer: false,
      inTrash: true,
    });
  });
});
