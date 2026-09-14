import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { GitRepository, PointerAt, TreeEntry } from "../app/ports.ts";
import { UsageError } from "../domain/errors.ts";
import type { PointerChange } from "../domain/history.ts";
import { MAX_POINTER_SIZE, type Pointer, parsePointer } from "../domain/pointer.ts";
import { CommandError, interactive, output, runSync } from "./proc.ts";

const NULL_OBJECT = /^0+$/;

export function gitLfsInstalled(): boolean {
  return runSync("git", ["lfs", "version"]).code === 0;
}

/** A local clone, driven through the git and git-lfs executables. */
export class Git implements GitRepository {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static open(dir = process.cwd()): Git {
    const result = runSync("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    if (result.code !== 0) throw new UsageError(`${dir} is not inside a git repository`);
    return new Git(result.stdout.toString().trim());
  }

  private run(args: string[], input?: string): string {
    return output("git", ["-C", this.dir, ...args], { input });
  }

  private tryRun(args: string[]): string | undefined {
    const result = runSync("git", ["-C", this.dir, ...args]);
    return result.code === 0 ? result.stdout.toString() : undefined;
  }

  config(key: string, file?: string): string | undefined {
    const args = file ? ["config", "-f", file, "--get", key] : ["config", "--get", key];
    return this.tryRun(args)?.trim() || undefined;
  }

  lfsUrl(): string | undefined {
    return this.config("lfs.url") ?? this.config("lfs.url", ".lfsconfig");
  }

  remoteUrl(remote = "origin"): string | undefined {
    return this.config(`remote.${remote}.url`);
  }

  isClean(): boolean {
    return this.run(["status", "--porcelain"]).trim() === "";
  }

  refTips(): string[] {
    const tips = new Set<string>();
    const format = "%(objectname) %(objecttype) %(*objectname) %(*objecttype)";
    for (const line of this.run(["for-each-ref", `--format=${format}`]).split("\n")) {
      const [id, type, peeled, peeledType] = line.split(" ");
      if (type === "commit" && id) tips.add(id);
      else if (peeledType === "commit" && peeled) tips.add(peeled);
    }
    return [...tips];
  }

  resolveCommit(rev: string): string {
    const sha = this.tryRun(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])?.trim();
    if (!sha) throw new UsageError(`${rev} is not a commit, branch or tag`);
    return sha;
  }

  hasTag(tag: string): boolean {
    return this.tryRun(["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]) !== undefined;
  }

  commitsSince(sinceUnix: number): { sha: string; time: number }[] {
    // Filtered here rather than with --since, which stops walking at the first older commit
    // and so skips newer commits behind a commit with a skewed date.
    return this.run(["log", "--all", "--no-show-signature", "--format=%H %ct"])
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, time] = line.split(" ");
        return { sha: sha!, time: Number(time) };
      })
      .filter((c) => c.time >= sinceUnix);
  }

  resolvePointers(blobs: Iterable<string>): Map<string, Pointer> {
    const unique = [...new Set(blobs)];
    const pointers = new Map<string, Pointer>();
    if (unique.length === 0) return pointers;

    const small: string[] = [];
    const check = this.run(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], `${unique.join("\n")}\n`);
    for (const line of check.split("\n")) {
      const [id, type, size] = line.split(" ");
      if (id && type === "blob" && Number(size) < MAX_POINTER_SIZE) small.push(id);
    }
    if (small.length === 0) return pointers;

    // Read as bytes: small non-pointer blobs may be binary, which would skew string offsets.
    const result = runSync("git", ["-C", this.dir, "cat-file", "--batch"], { input: `${small.join("\n")}\n` });
    if (result.code !== 0) throw new CommandError("git cat-file --batch", result.code, result.stderr);
    const buf = result.stdout;
    let offset = 0;
    while (offset < buf.length) {
      const headerEnd = buf.indexOf(0x0a, offset);
      const [id, type, sizeText] = buf.toString("latin1", offset, headerEnd).split(" ");
      if (type !== "blob") {
        offset = headerEnd + 1;
        continue;
      }
      const size = Number(sizeText);
      const pointer = parsePointer(buf.toString("latin1", headerEnd + 1, headerEnd + 1 + size));
      if (pointer && id) pointers.set(id, pointer);
      offset = headerEnd + 1 + size + 1;
    }
    return pointers;
  }

  pointersIn(commits: Iterable<string>): Map<string, PointerAt> {
    const list = [...new Set(commits)];
    const found = new Map<string, PointerAt>();
    if (list.length === 0) return found;

    const blobPaths = new Map<string, Set<string>>();
    // --no-walk lists the full trees of exactly these commits without walking their parents.
    const objects = this.run(["rev-list", "--objects", "--no-walk", "--stdin"], `${list.join("\n")}\n`);
    for (const line of objects.split("\n")) {
      const space = line.indexOf(" ");
      if (space === -1) continue;
      const id = line.slice(0, space);
      let paths = blobPaths.get(id);
      if (!paths) {
        paths = new Set();
        blobPaths.set(id, paths);
      }
      paths.add(line.slice(space + 1));
    }
    for (const [blob, pointer] of this.resolvePointers(blobPaths.keys())) {
      const entry = found.get(pointer.oid) ?? { ...pointer, paths: new Set<string>() };
      for (const path of blobPaths.get(blob) ?? []) entry.paths.add(path);
      found.set(pointer.oid, entry);
    }
    return found;
  }

  pointerHistory(): PointerChange[] {
    const raw = this.run([
      "log",
      "--all",
      // Explicit, so user settings such as log.showRoot=false cannot hide changes.
      "--root",
      "--no-show-signature",
      "--no-color",
      "--diff-merges=first-parent",
      "--format=%x01%H %ct",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "-z",
    ]);
    const changes: { blob: string; path: string; commit: string; time: number }[] = [];
    let commit = "";
    let time = 0;
    let pendingBlob: string | undefined;
    for (const token of raw.split("\0")) {
      if (token.startsWith("\x01")) {
        const [sha, ct] = token.slice(1).trim().split(" ");
        commit = sha!;
        time = Number(ct);
        continue;
      }
      const meta = token.replace(/^\n/, "");
      if (meta.startsWith(":")) {
        // ":<old mode> <new mode> <old blob> <new blob> <status>"
        const [, newMode, , newBlob] = meta.slice(1).split(" ");
        pendingBlob = newMode?.startsWith("100") && newBlob && !NULL_OBJECT.test(newBlob) ? newBlob : undefined;
        continue;
      }
      if (pendingBlob && token) changes.push({ blob: pendingBlob, path: token, commit, time });
      pendingBlob = undefined;
    }

    const pointers = this.resolvePointers(changes.map((c) => c.blob));
    return changes.flatMap((c) => {
      const pointer = pointers.get(c.blob);
      return pointer ? [{ ...pointer, path: c.path, commit: c.commit, time: c.time }] : [];
    });
  }

  treeEntries(commit: string): TreeEntry[] {
    return this.run(["ls-tree", "-r", "-l", "-z", commit])
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf("\t");
        const [mode, type, object, size] = entry.slice(0, tab).split(/\s+/);
        return { mode: mode!, type: type!, object: object!, size: Number(size) || 0, path: entry.slice(tab + 1) };
      });
  }

  readBlob(object: string): Uint8Array {
    const result = runSync("git", ["-C", this.dir, "cat-file", "blob", object]);
    if (result.code !== 0) throw new CommandError(`git cat-file blob ${object}`, result.code, result.stderr);
    return result.stdout;
  }

  readFile(relativePath: string): string | undefined {
    const file = join(this.dir, relativePath);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  /** The fetch refspecs of every remote, except push mirrors, which are never fetched from. */
  private fetchRefspecs(): Map<string, string[]> {
    const remotes = new Map<string, string[]>();
    for (const remote of (this.tryRun(["remote"]) ?? "").split("\n").filter(Boolean)) {
      const specs = (this.tryRun(["config", "--get-all", `remote.${remote}.fetch`]) ?? "").split("\n").filter(Boolean);
      const mirror = this.tryRun(["config", "--type=bool", "--get", `remote.${remote}.mirror`])?.trim() === "true";
      if (specs.length === 0 && mirror) continue;
      remotes.set(remote, specs);
    }
    return remotes;
  }

  fetchAll(): boolean {
    for (const [remote, specs] of this.fetchRefspecs()) {
      // Tags are left to the second fetch, whatever tagOpt or tag refspecs the user configured: those would fail
      // on a tag moved on the remote, or prune local tags gc must still see. The empty --refmap stops configured
      // refspecs from also updating refs/tags on the side; git ignores pruneTags when refspecs are given.
      const noTags = ["fetch", "--prune", "--no-tags", "--refmap=", "--quiet", remote];
      const branches = specs.filter((spec) => !spec.includes(":refs/tags/"));
      if (branches.length > 0 && this.tryRun([...noTags, ...branches]) === undefined) return false;
      // Every tag, including those whose commits no branch contains, in a namespace of its own.
      if (this.tryRun([...noTags, `+refs/tags/*:refs/r2-lfs/tags/${remote}/*`]) === undefined) return false;
    }
    return true;
  }

  historyGaps(): string[] {
    const gaps: string[] = [];
    if (this.tryRun(["rev-parse", "--is-shallow-repository"])?.trim() === "true") {
      gaps.push("it is a shallow clone; run `git fetch --unshallow`");
    }
    for (const [remote, specs] of this.fetchRefspecs()) {
      const everyBranch = specs.some((spec) => /^\+?refs\/heads\/\*:/.test(spec)) && !specs.some((spec) => spec.startsWith("^"));
      if (!everyBranch) {
        gaps.push(`remote ${remote} fetches only some branches; run \`git remote set-branches ${remote} '*'\` and fetch`);
      }
    }
    return gaps;
  }

  setLfsConfig(key: string, value: string): void {
    this.run(["config", "-f", ".lfsconfig", key, value]);
  }

  lfsTrack(patterns: string[], opts: { lockable?: boolean } = {}): void {
    if (patterns.length > 0) this.run(["lfs", "track", ...(opts.lockable ? ["--lockable"] : []), ...patterns]);
  }

  lfsInstalled(): boolean {
    return gitLfsInstalled();
  }

  lfsHooksInstalled(): boolean {
    return this.config("filter.lfs.process") !== undefined;
  }

  /** Shared by every worktree of the clone. */
  commonGitDir(): string {
    return resolve(this.dir, this.run(["rev-parse", "--git-common-dir"]).trim());
  }

  lfsObjectPath(oid: string): string {
    const media = this.tryRun(["lfs", "env"])?.match(/^LocalMediaDir=(.*)$/m)?.[1];
    const base = media ?? join(this.run(["rev-parse", "--absolute-git-dir"]).trim(), "lfs", "objects");
    return join(base, oid.slice(0, 2), oid.slice(2, 4), oid);
  }

  lfsFetch(remote: string, refs: string[], opts: { all?: boolean; url?: string } = {}): Promise<number> {
    const urlOverride = opts.url ? ["-c", `lfs.url=${opts.url}`] : [];
    return interactive("git", ["-C", this.dir, ...urlOverride, "lfs", "fetch", ...(opts.all ? ["--all"] : []), remote, ...refs]);
  }

  async lfsPushAll(remote: string): Promise<number> {
    // Without refs, git lfs push --all covers only local branches and tags, not the remote-tracking branches
    // and remote tags fetched before. Batched to stay within command-line length limits.
    const tips = this.refTips();
    for (let i = 0; i < tips.length; i += 100) {
      const code = await interactive("git", ["-C", this.dir, "lfs", "push", "--all", remote, ...tips.slice(i, i + 100)]);
      if (code !== 0) return code;
    }
    return 0;
  }

  lfsMigrateImport(patterns: string[]): Promise<number> {
    return interactive("git", ["-C", this.dir, "lfs", "migrate", "import", "--everything", `--include=${patterns.join(",")}`]);
  }

  commitFiles(paths: string[], message: string): boolean {
    this.run(["add", "--", ...paths]);
    if (this.tryRun(["diff", "--cached", "--quiet"]) !== undefined) return false;
    this.run(["commit", "--quiet", "-m", message]);
    return true;
  }
}
