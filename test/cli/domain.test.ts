import { describe, expect, it } from "vitest";

import { UsageError } from "../../cli/domain/errors.ts";
import { buildHistory } from "../../cli/domain/history.ts";
import { combinePlans, type Facts, planObjects } from "../../cli/domain/plan.ts";
import { parsePointer } from "../../cli/domain/pointer.ts";
import { effectiveFor, globMatch, keepDayWindows, parsePolicy } from "../../cli/domain/policy.ts";
import { expandTracks } from "../../cli/domain/presets.ts";
import { githubLfsEndpoint, parseLfsUrl, parseRemote } from "../../cli/domain/remote.ts";
import { END_BYTES, entryBytes, encodeHeader, paxRecordsFor, splitParts, type TarEntry } from "../../cli/domain/tar.ts";
import { addToken, emptyTokensFile, parseTokensFile, revokeToken } from "../../cli/domain/tokens.ts";
import { bucketUsage, fileUsage, monthlyCost } from "../../cli/domain/usage.ts";
import { DAY_MS } from "./helpers.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

const facts = (over: Partial<Facts> = {}): Facts => ({
  paths: new Map(),
  tips: new Set(),
  windows: new Map([[90, new Set()]]),
  versions: new Map(),
  ...over,
});

const tarFile = (name: string, size: number): TarEntry => ({
  name,
  size,
  mode: 0o644,
  source: { kind: "buffer", data: new Uint8Array(size) },
});

describe("parsePointer", () => {
  it("reads oid and size", () => {
    expect(parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${A}\nsize 42\n`)).toEqual({ oid: A, size: 42 });
  });

  it("rejects files that only look similar", () => {
    expect(parsePointer(`oid sha256:${A}\nsize 42\n`)).toBeUndefined();
    expect(parsePointer("version https://git-lfs.github.com/spec/v1\nsize 42\n")).toBeUndefined();
    expect(parsePointer(`version https://example.com/spec/v1\noid sha256:${A}\nsize 42\n`)).toBeUndefined();
  });

  it("accepts CRLF line endings and the version lines git-lfs still reads", () => {
    for (const version of ["https://git-lfs.github.com/spec/v1", "https://hawser.github.com/spec/v1", "http://git-media.io/v/2"]) {
      expect(parsePointer(`version ${version}\r\noid sha256:${A}\r\nsize 42\r\n`)).toEqual({ oid: A, size: 42 });
    }
  });
});

describe("remote parsing", () => {
  it.each([
    ["https://github.com/acme/assets.git", "acme", "assets"],
    ["git@github.com:acme/assets.git", "acme", "assets"],
    ["ssh://git@github.com/acme/assets", "acme", "assets"],
    ["https://token@github.example.com:8443/acme/assets/", "acme", "assets"],
  ])("parses %s", (url, owner, repo) => {
    expect(parseRemote(url)).toMatchObject({ owner, repo });
  });

  it("parses lfs.url in either style", () => {
    expect(parseLfsUrl("https://lfs.example.com/acme/assets")).toMatchObject({
      origin: "https://lfs.example.com",
      owner: "acme",
      repo: "assets",
    });
    expect(parseLfsUrl("https://lfs.example.com/acme/assets.git/info/lfs")).toMatchObject({ repo: "assets" });
    expect(parseLfsUrl("https://lfs.example.com/acme")).toBeUndefined();
    expect(parseLfsUrl("not a url")).toBeUndefined();
  });

  it("derives GitHub's LFS endpoint", () => {
    expect(githubLfsEndpoint({ host: "github.com", owner: "acme", repo: "assets" })).toBe("https://github.com/acme/assets.git/info/lfs");
  });
});

describe("policy", () => {
  it("uses defaults without a file", () => {
    expect(parsePolicy(undefined)).toMatchObject({ keepDays: 90, keepVersions: 0, minAgeDays: 30, oldVersions: "delete", rules: [] });
  });

  it("parses rules and reports every problem at once", () => {
    const policy = parsePolicy(
      `keep_days = 60\n[[rule]]\npath = "textures/**"\nkeep_versions = 3\nold_versions = "infrequent-access"\n[[rule]]\npath = "final/**"\nkeep = "all"\n`,
    );
    expect(policy.keepDays).toBe(60);
    expect(policy.rules).toEqual([
      { path: "textures/**", keepVersions: 3, oldVersions: "infrequent-access", keepDays: undefined, keepAll: undefined },
      { path: "final/**", keepAll: true, keepDays: undefined, keepVersions: undefined, oldVersions: undefined },
    ]);
    const error = thrown(() => parsePolicy('keep_days = -1\nfoo = 1\n[[rule]]\nkeep = "some"\n'));
    expect(error).toBeInstanceOf(UsageError);
    expect(String(error)).toMatch(/keep_days must be/);
    expect(String(error)).toMatch(/unknown setting "foo"/);
    expect(String(error)).toMatch(/rule #1: path is required/);

    const patterns = thrown(() => parsePolicy('[[rule]]\npath = "shots/take[[:Digit:]].exr"\nkeep = "all"\n[[rule]]\npath = "[z-a]/**"\n'));
    expect(String(patterns)).toMatch(/rule #1: path "shots\/take\[\[:Digit:\]\]\.exr" is not a valid pattern/);
    expect(String(patterns)).toMatch(/rule #2: path "\[z-a\]\/\*\*" is not a valid pattern/);
    expect(() => parsePolicy('[[rule]]\npath = "shots/[0-9"\n')).toThrow(/is not a valid pattern/);
    expect(() => parsePolicy("[[rule]]\npath = 'trailing\\'\n")).toThrow(/is not a valid pattern/);
  });

  it.each([
    ["*.blend", "scene.blend", true],
    ["*.blend", "chars/hero/hero.blend", true],
    ["chars/*.blend", "chars/hero/hero.blend", false],
    ["chars/**", "chars/hero/hero.blend", true],
    ["chars/", "chars/hero.blend", true],
    ["**/final/*.png", "a/b/final/x.png", true],
    ["/top.psd", "top.psd", true],
    ["/top.psd", "sub/top.psd", false],
    ["tex?.png", "tex1.png", true],
    ["*.[pP][nN][gG]", "shots/HERO.PNG", true],
    ["shots/[0-9]*/final.exr", "shots/010/final.exr", true],
    ["shots/[0-9]*/final.exr", "shots/intro/final.exr", false],
    ["take[!0-9].wav", "takeA.wav", true],
    ["take[!0-9].wav", "take1.wav", false],
    ["take[^0-9].wav", "takeB.wav", true],
    ["a[!x]b", "a/b", false],
    ["take[[:digit:]].wav", "take1.wav", true],
    ["take[[:digit:][:upper:]].wav", "takeZ.wav", true],
    ["take[![:alpha:]].wav", "take1.wav", true],
    ["take[![:alpha:]].wav", "takeA.wav", false],
    ["take[[:bogus:]].wav", "takeb].wav", false],
    ["a[[:digit:]-z]b", "a-b", true],
    ["[z-a].bin", "b.bin", false],
    ["a[]]b", "a]b", true],
    ["literal[", "literal[", false],
    ["[!-x].bin", "a.bin", true],
    ["[!-x].bin", "-.bin", false],
    ["[^-x].bin", "5.bin", true],
    ["a[/]b", "a/b", false],
    ["a[.-0]b", "a/b", false],
    ["a[[:punct:]]b", "a/b", false],
    ["a[[:punct:]]b", "a.b", true],
    ["a**b.bin", "a/x/b.bin", false],
    ["a**b.bin", "axyb.bin", true],
    ["x**/y.bin", "xa/b/y.bin", false],
    ["x**/y.bin", "xa/y.bin", true],
    ["foo**", "foox", true],
    ["shot\\[1\\].exr", "shot[1].exr", true],
    ["shot\\[1\\].exr", "shot1.exr", false],
    ["a\\*b", "a*b", true],
    ["a\\*b", "axb", false],
    ["take[a\\-c].wav", "take-.wav", true],
    ["take[a\\-c].wav", "takeb.wav", false],
    ["take[\\]].wav", "take].wav", true],
    ["a/**/b.psd", "a/x/y/b.psd", true],
    ["a/**/b.psd", "a/b.psd", true],
    ["**", "any/depth/file.bin", true],
  ])("glob %s matches %s: %s", (pattern, path, expected) => {
    expect(globMatch(pattern, path)).toBe(expected);
  });

  it("applies the first matching rule and scans each keep_days window once", () => {
    const policy = parsePolicy(`[[rule]]\npath = "raw/**"\nkeep_days = 7\n[[rule]]\npath = "**"\nkeep_days = 7\n`);
    expect(effectiveFor(policy, "raw/a.exr")).toMatchObject({ keepDays: 7, rule: "raw/**" });
    expect(effectiveFor(policy, undefined)).toMatchObject({ keepDays: 90, rule: undefined });
    expect(keepDayWindows(policy)).toEqual([7, 90]);
  });
});

describe("planObjects", () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const stored = (key: string, ageDays: number, storageClass = "STANDARD") => ({
    key,
    size: 10,
    lastModified: new Date(now.getTime() - ageDays * DAY_MS),
    storageClass,
  });

  it("keeps tips and recent objects, spares young ones, collects the rest", () => {
    const plan = planObjects(
      [stored(`r/${A}`, 400), stored(`r/${B}`, 400), stored(`r/${C}`, 5), stored(`r/${D}`, 400), stored("r/README", 400)],
      facts({ tips: new Set([A]), windows: new Map([[90, new Set([B])]]) }),
      parsePolicy(undefined),
      now,
    );
    expect(plan.map((p) => p.decision.kind)).toEqual(["keep", "keep", "young", "delete", "foreign"]);
  });

  it("keeps the newest N versions of a path and tiers instead of deleting when a rule says so", () => {
    const policy = parsePolicy(`[[rule]]\npath = "tex/**"\nkeep_versions = 1\nold_versions = "infrequent-access"\n`);
    const plan = planObjects(
      [stored(`r/${A}`, 400), stored(`r/${B}`, 400), stored(`r/${C}`, 400, "STANDARD_IA")],
      facts({
        paths: new Map([
          [A, new Set(["tex/a.png"])],
          [B, new Set(["tex/a.png"])],
          [C, new Set(["tex/a.png"])],
        ]),
        versions: new Map([["tex/a.png", [A, B, C]]]),
      }),
      policy,
      now,
    );
    expect(plan.map((p) => p.decision)).toEqual([
      { kind: "keep", reason: "tex/a.png: one of the newest 1 versions" },
      { kind: "tier" },
      { kind: "keep", reason: "already in Infrequent Access" },
    ]);
  });

  it("never collects a path covered by keep = all", () => {
    const policy = parsePolicy(`[[rule]]\npath = "final/**"\nkeep = "all"\n`);
    const [planned] = planObjects([stored(`r/${A}`, 400)], facts({ paths: new Map([[A, new Set(["final/hero.blend"])]]) }), policy, now);
    expect(planned?.decision.kind).toBe("keep");
  });

  it("keeps an object when any of its paths keeps it, and tiers when any path asks for it", () => {
    const policy = parsePolicy(
      `[[rule]]\npath = "final/**"\nkeep = "all"\n[[rule]]\npath = "cold/**"\nold_versions = "infrequent-access"\n`,
    );
    const plan = planObjects(
      [stored(`r/${A}`, 400), stored(`r/${B}`, 400)],
      facts({
        paths: new Map([
          [A, new Set(["wip/a.exr", "final/a.exr"])],
          [B, new Set(["wip/b.exr", "cold/b.exr"])],
        ]),
      }),
      policy,
      now,
    );
    expect(plan.map((p) => p.decision)).toEqual([
      { kind: "keep", reason: 'final/a.exr: rule "final/**" keeps all versions' },
      { kind: "tier" },
    ]);
  });

  it("combines plans from several repositories, letting the most lenient decision win", () => {
    const objects = [stored(`r/${A}`, 400), stored(`r/${B}`, 400), stored(`r/${C}`, 400), stored(`r/${D}`, 400)];
    const policy = parsePolicy(undefined);
    const tiering = parsePolicy('old_versions = "infrequent-access"\n');
    const first = planObjects(objects, facts({ paths: new Map([[A, new Set(["a.png"])]]) }), policy, now);
    const second = planObjects(
      objects,
      facts({ tips: new Set([A]), paths: new Map([[A, new Set(["b/a.png"])]]), windows: new Map([[90, new Set([B])]]) }),
      tiering,
      now,
    );
    const combined = combinePlans([first, second]);
    expect(combined.map((p) => p.decision.kind)).toEqual(["keep", "keep", "tier", "tier"]);
    expect(combined[0]?.paths).toEqual(["a.png", "b/a.png"]);
    expect(combinePlans([first]).map((p) => p.decision.kind)).toEqual(["delete", "delete", "delete", "delete"]);
  });
});

describe("history", () => {
  it("orders versions newest first and records every path", () => {
    const history = buildHistory([
      { oid: A, size: 1, path: "x.blend", commit: "c1", time: 100 },
      { oid: B, size: 2, path: "x.blend", commit: "c2", time: 200 },
      { oid: A, size: 1, path: "copy.blend", commit: "c3", time: 300 },
      { oid: A, size: 1, path: "x.blend", commit: "c4", time: 400 },
    ]);
    expect(history.versions.get("x.blend")?.map((v) => v.oid)).toEqual([A, B]);
    expect([...(history.paths.get(A) ?? [])].toSorted()).toEqual(["copy.blend", "x.blend"]);
    expect(history.sizes.get(B)).toBe(2);
  });
});

describe("usage", () => {
  it("sums versions per file and splits bucket bytes by class", () => {
    const history = buildHistory([
      { oid: A, size: 100, path: "big.blend", commit: "c1", time: 1 },
      { oid: B, size: 300, path: "big.blend", commit: "c2", time: 2 },
      { oid: C, size: 50, path: "small.png", commit: "c3", time: 3 },
    ]);
    const files = fileUsage(history, new Map([[A, "missing"]]));
    expect(files[0]).toEqual({ path: "big.blend", versions: 2, totalBytes: 400, latestBytes: 300, missing: 1 });

    const date = new Date();
    const usage = bucketUsage(
      history,
      [
        { key: `p/${B}`, size: 300, lastModified: date, storageClass: "STANDARD" },
        { key: `p/${C}`, size: 50, lastModified: date, storageClass: "STANDARD_IA" },
        { key: `p/${D}`, size: 7, lastModified: date, storageClass: "STANDARD" },
      ],
      [{ key: `_trash/p/${A}`, size: 100, lastModified: date, storageClass: "STANDARD" }],
    );
    expect(usage).toMatchObject({ storedBytes: 357, infrequentAccessBytes: 50, orphanedBytes: 7, trashBytes: 100 });
    expect(monthlyCost(1024 ** 3, 1024 ** 3)).toBeCloseTo(0.025);
  });
});

describe("tokens", () => {
  const input = { label: "ci", scope: "Acme/*", readOnly: true, id: "id1", sha256: "f".repeat(64), created: new Date("2026-01-01") };

  it("adds, lists and revokes", () => {
    const { file, entry } = addToken(emptyTokensFile(), input);
    expect(entry).toMatchObject({ scope: "acme/*", permission: "read" });
    expect(() => addToken(file, input)).toThrow(/already exists/);
    expect(() => addToken(file, { ...input, label: "x", scope: "acme" })).toThrow(/scope/);
    expect(revokeToken(file, "ci").file.tokens).toEqual([]);
    expect(() => revokeToken(file, "nope")).toThrow(/no token/);
  });

  it("rejects unexpected files", () => {
    expect(() => parseTokensFile("{")).toThrow(/JSON/);
    expect(() => parseTokensFile('{"version":2}')).toThrow(/format/);
  });
});

describe("tar layout", () => {
  it("encodes a header with a valid checksum", () => {
    const header = encodeHeader({ name: "a.txt", size: 5, mode: 0o644, mtime: 0, type: "0" });
    const stored = Number.parseInt(new TextDecoder().decode(header.subarray(148, 154)), 8);
    const copy = header.slice();
    copy.fill(32, 148, 156);
    expect(stored).toBe(copy.reduce((s, b) => s + b, 0));
  });

  it("adds PAX records only for long names, with a self-counting length", () => {
    expect(paxRecordsFor(tarFile("short", 1))).toBeUndefined();
    const name = `${"dir/".repeat(30)}file.blend`;
    const record = new TextDecoder().decode(paxRecordsFor(tarFile(name, 1)));
    const length = Number(record.split(" ")[0]);
    expect(new TextEncoder().encode(record).length).toBe(length);
    expect(entryBytes(tarFile(name, 1))).toBe(512 + 512 + 512 + 512);
  });

  it("splits into parts under the limit and refuses entries that cannot fit", () => {
    const entries = [tarFile("a", 1000), tarFile("b", 1000), tarFile("c", 1000)];
    const parts = splitParts(entries, 512 * 6 + END_BYTES);
    expect(parts.map((p) => p.map((e) => e.name))).toEqual([["a", "b"], ["c"]]);
    expect(() => splitParts([tarFile("huge", 10_000)], 4096)).toThrow(UsageError);
  });
});

describe("presets", () => {
  it("expands names and keeps literal patterns without duplicates", () => {
    const patterns = expandTracks(["blender,*.blend", "*.kra"]);
    expect(patterns).toContain("*.fbx");
    expect(patterns.filter((p) => p === "*.blend")).toHaveLength(1);
    expect(patterns).toContain("*.kra");
  });
});
