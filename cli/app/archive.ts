import { join } from "node:path";

import { UsageError } from "../domain/errors.ts";
import { parseRemote } from "../domain/remote.ts";
import { partNames, splitParts, type TarEntry } from "../domain/tar.ts";
import type { Files, GitHubCli, GitRepository, Reporter } from "./ports.ts";

// GitHub release assets must be under 2 GiB each; leave headroom for tar headers.
export const DEFAULT_PART_BYTES = 2 * 1024 ** 3 - 16 * 1024 ** 2;

export interface ArchiveDeps {
  repo: GitRepository;
  gh: GitHubCli;
  files: Files;
  reporter: Reporter;
}

export interface ArchiveOptions {
  tag: string;
  /** A fresh temporary directory when omitted. */
  outputDir?: string;
  partBytes: number;
  upload: boolean;
  remote: string;
}

export interface ArchiveResult {
  outputDir: string;
  files: string[];
  totalBytes: number;
  published: boolean;
}

function entriesFor(repo: GitRepository, files: Files, commit: string): TarEntry[] {
  const blobs = repo.treeEntries(commit).filter((e) => e.type === "blob");
  const pointers = repo.resolvePointers(blobs.map((e) => e.object));
  const decoder = new TextDecoder();
  return blobs.map((e): TarEntry => {
    if (e.mode === "120000")
      return { name: e.path, size: 0, mode: 0o777, source: { kind: "symlink", target: decoder.decode(repo.readBlob(e.object)) } };
    const mode = e.mode === "100755" ? 0o755 : 0o644;
    const pointer = pointers.get(e.object);
    if (pointer) {
      const file = repo.lfsObjectPath(pointer.oid);
      if (files.sizeOf(file) !== pointer.size) throw new UsageError(`the LFS object for ${e.path} is not available locally`);
      return { name: e.path, size: pointer.size, mode, source: { kind: "file", path: file } };
    }
    const data = repo.readBlob(e.object);
    return { name: e.path, size: data.length, mode, source: { kind: "buffer", data } };
  });
}

/** Packs a tag, LFS content included, into tar parts and optionally publishes them as a GitHub release. */
export async function archiveTag(deps: ArchiveDeps, opts: ArchiveOptions): Promise<ArchiveResult> {
  const { repo, gh, files: fs, reporter } = deps;
  const commit = repo.resolveCommit(opts.tag);
  const remote = parseRemote(repo.remoteUrl(opts.remote) ?? "");
  const ghRepo = remote ? `${remote.owner}/${remote.repo}` : undefined;
  if (opts.upload) {
    if (!repo.hasTag(opts.tag))
      throw new UsageError(`${opts.tag} is not a tag; releases need one (git tag ${opts.tag} && git push origin ${opts.tag})`);
    if (!gh.available()) throw new UsageError("publishing needs the GitHub CLI (gh); pass --no-upload to only write the parts");
    if (gh.releaseState(ghRepo, opts.tag) === "published") {
      throw new UsageError(`release ${opts.tag} is already published and cannot take new assets`);
    }
  }

  reporter.step(`Fetching LFS files for ${opts.tag}`);
  const fetched = await repo.lfsFetch(opts.remote, [opts.tag]);
  if (fetched !== 0) throw new UsageError(`git lfs fetch failed (exit ${fetched})`);

  const entries = entriesFor(repo, fs, commit);
  const parts = splitParts(entries, opts.partBytes);
  const names = partNames(remote?.repo ?? "archive", opts.tag, parts.length);
  const outputDir = opts.outputDir ?? fs.tempDir("r2-lfs-archive-");
  fs.mkdirp(outputDir);

  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  const bar = reporter.progress(entries.length, `Writing ${parts.length} part(s)`);
  const files: string[] = [];
  const sums: string[] = [];
  for (const [i, part] of parts.entries()) {
    const file = join(outputDir, names[i]!);
    await fs.writeTar(file, part, (entry) => bar.advance(1, entry.name));
    files.push(file);
    sums.push(`${await fs.sha256(file)}  ${names[i]}`);
  }
  bar.stop(`Wrote ${parts.length} part(s) to ${outputDir}`);
  const sumsFile = join(outputDir, "SHA256SUMS");
  fs.writeText(sumsFile, `${sums.join("\n")}\n`);
  files.push(sumsFile);

  if (!opts.upload) return { outputDir, files, totalBytes, published: false };

  // Assets go onto a draft first: once published, an immutable release cannot change.
  if (gh.releaseState(ghRepo, opts.tag) === undefined) {
    await reporter.task("Creating a draft release", () =>
      gh.createDraftRelease(ghRepo, opts.tag, opts.tag, `Snapshot of ${opts.tag} with Git LFS files, made by r2-lfs archive.`),
    );
  }
  reporter.step(`Uploading ${files.length} assets`);
  const uploaded = await gh.uploadAssets(ghRepo, opts.tag, files);
  if (uploaded !== 0) throw new UsageError("gh release upload failed; the draft release is left in place for you to retry");
  await reporter.task("Publishing the release", () => gh.publishRelease(ghRepo, opts.tag));
  return { outputDir, files, totalBytes, published: true };
}
