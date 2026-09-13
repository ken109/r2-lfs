import { describe, expect, it } from "vitest";
import { parseListObjects, parsePointer, planDeletions, type StoredObject } from "../scripts/gc/select.ts";

const OID_A = "a".repeat(64);
const OID_B = "b".repeat(64);
const OID_C = "c".repeat(64);

describe("parsePointer", () => {
  it("reads the oid of a pointer file", () => {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID_A}\nsize 12345\n`;
    expect(parsePointer(pointer)).toBe(OID_A);
  });

  it("ignores ordinary small files", () => {
    expect(parsePointer(`oid sha256:${OID_A}\n`)).toBeUndefined();
    expect(parsePointer("hello\n")).toBeUndefined();
  });
});

describe("parseListObjects", () => {
  it("parses keys, sizes, dates and the continuation token", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <Contents><Key>acme/app/${OID_A}</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified><Size>10</Size></Contents>
  <Contents><Key>acme/app/a&amp;b</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified><Size>3</Size></Contents>
  <NextContinuationToken>tok&amp;en</NextContinuationToken>
</ListBucketResult>`;
    const page = parseListObjects(xml);
    expect(page.objects).toEqual([
      { key: `acme/app/${OID_A}`, size: 10, lastModified: new Date("2026-01-02T03:04:05.000Z") },
      { key: "acme/app/a&b", size: 3, lastModified: new Date("2026-01-02T03:04:05.000Z") },
    ]);
    expect(page.nextToken).toBe("tok&en");
  });

  it("stops when the listing is not truncated", () => {
    expect(parseListObjects("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>").nextToken).toBeUndefined();
  });
});

describe("planDeletions", () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const object = (key: string, age: number): StoredObject => ({ key, size: 1, lastModified: daysAgo(age) });

  it("keeps referenced objects, spares young ones and deletes the rest", () => {
    const plan = planDeletions(
      [object(`acme/app/${OID_A}`, 400), object(`acme/app/${OID_B}`, 5), object(`acme/app/${OID_C}`, 400), object("acme/app/README", 400)],
      new Set([OID_A]),
      30,
      now,
    );
    expect(plan.keep.map((o) => o.key)).toEqual([`acme/app/${OID_A}`]);
    expect(plan.young.map((o) => o.key)).toEqual([`acme/app/${OID_B}`]);
    expect(plan.delete.map((o) => o.key)).toEqual([`acme/app/${OID_C}`]);
    expect(plan.foreign.map((o) => o.key)).toEqual(["acme/app/README"]);
  });
});
