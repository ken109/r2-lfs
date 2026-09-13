import type { GitHubCli } from "../app/ports.ts";
import { interactive, output, runSync } from "./proc.ts";

const repoFlag = (repo: string | undefined) => (repo ? ["-R", repo] : []);

export class GhCli implements GitHubCli {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  available(): boolean {
    return runSync("gh", ["--version"]).code === 0;
  }

  loggedIn(): boolean {
    return this.available() && runSync("gh", ["auth", "token"]).code === 0;
  }

  releaseState(repo: string | undefined, tag: string): "draft" | "published" | undefined {
    const result = runSync("gh", ["release", "view", tag, ...repoFlag(repo), "--json", "isDraft"], { cwd: this.cwd });
    if (result.code !== 0) return undefined;
    return (JSON.parse(result.stdout.toString()) as { isDraft: boolean }).isDraft ? "draft" : "published";
  }

  createDraftRelease(repo: string | undefined, tag: string, title: string, notes: string): void {
    output("gh", ["release", "create", tag, ...repoFlag(repo), "--draft", "--verify-tag", "--title", title, "--notes", notes], {
      cwd: this.cwd,
    });
  }

  uploadAssets(repo: string | undefined, tag: string, files: string[]): Promise<number> {
    return interactive("gh", ["release", "upload", tag, ...repoFlag(repo), ...files, "--clobber"], { cwd: this.cwd });
  }

  publishRelease(repo: string | undefined, tag: string): void {
    output("gh", ["release", "edit", tag, ...repoFlag(repo), "--draft=false"], { cwd: this.cwd });
  }
}
