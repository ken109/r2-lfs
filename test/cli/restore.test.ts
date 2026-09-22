import { describe, expect, it } from "vitest";

import { listTrash, restoreObjects, selectTrash } from "../../cli/app/restore.ts";
import { BucketStorage } from "../../cli/infra/bucket-storage.ts";
import { at, cleanups, MemoryBucket, scenario, scenarioDeps, SilentReporter, storedObject } from "./helpers.ts";

const cleanup = cleanups();

/** An object in the trash, trashed `daysAgo` days ago. */
const trashed = (oid: string, daysAgo: number) => ({
  object: { ...storedObject(`_trash/acme/assets/${oid}`), lastModified: at(daysAgo) },
  oid,
  paths: [],
});

describe("restore", () => {
  it("lists, selects by oid prefix and path, and restores", async () => {
    const s = scenario();
    cleanup(() => s.repo.remove());
    await s.bucket.copy(`${s.prefix}${s.oldOid}`, `_trash/${s.prefix}${s.oldOid}`);
    await s.bucket.delete(`${s.prefix}${s.oldOid}`);

    const deps = scenarioDeps(s);
    const trash = await listTrash(deps);
    expect(trash.map((t) => [t.oid, t.paths])).toEqual([[s.oldOid, ["hero.blend"]]]);
    expect(selectTrash(trash, { kind: "path", path: "hero.blend" })).toHaveLength(1);
    expect(() => selectTrash(trash, { kind: "oids", prefixes: ["zzz"] })).toThrow(/nothing in the trash/);

    const outcomes = await restoreObjects(
      { storage: deps.storage, reporter: deps.reporter },
      selectTrash(trash, { kind: "oids", prefixes: [s.oldOid.slice(0, 8)] }),
    );
    expect(outcomes).toEqual([{ oid: s.oldOid, ok: true }]);
    expect(s.bucket.objects.has(`${s.prefix}${s.oldOid}`)).toBe(true);
    expect(s.bucket.objects.has(`_trash/${s.prefix}${s.oldOid}`)).toBe(false);
  });

  it("selects by date and rejects ambiguous prefixes, and says when a restore is incomplete", async () => {
    const bucket = new MemoryBucket();
    const reporter = new SilentReporter();
    const trash = [trashed(`ab${"1".repeat(62)}`, 10), trashed(`ab${"2".repeat(62)}`, 1)];
    expect(selectTrash(trash, { kind: "since", date: at(5) }).map((t) => t.oid)).toEqual([trash[1]!.oid]);
    expect(() => selectTrash(trash, { kind: "oids", prefixes: ["ab"] })).toThrow(/ambiguous/);

    const [missing, locked] = trash;
    bucket.seed(locked!.object.key);
    bucket.locked.push("_trash/");
    expect(await restoreObjects({ storage: new BucketStorage(bucket), reporter }, [missing!, locked!])).toEqual([
      { oid: missing!.oid, ok: false, message: "copy failed: 404 NoSuchKey" },
      { oid: locked!.oid, ok: true, message: expect.stringContaining("trash copy could not be removed") },
    ]);
    expect(bucket.objects.has(`acme/assets/${locked!.oid}`)).toBe(true);
  });

  it("counts an object a lock rule keeps from being overwritten as restored, since it is already back", async () => {
    const bucket = new MemoryBucket();
    const back = trashed("c".repeat(64), 1);
    bucket.seed(back.object.key);
    bucket.seed(`acme/assets/${back.oid}`);
    bucket.locked.push("acme/");
    expect(await restoreObjects({ storage: new BucketStorage(bucket), reporter: new SilentReporter() }, [back])).toEqual([
      { oid: back.oid, ok: true },
    ]);
    expect(bucket.objects.has(back.object.key)).toBe(false);
  });
});
