import { parseRepository } from "./admin-locks.ts";
import type { Result } from "./lfs.ts";
import type { ActivitySource } from "./ports.ts";

/** Analytics Engine keeps data points for three months. */
const MAX_HOURS = 24 * 90;

export type Activity =
  | { enabled: false }
  | { enabled: true; hours: number; repositories: { repo: string; requests: number; bytes: number; errors: number }[] };

/** Requests by repository in the last `hours`, or only those of `repository` when it is given. */
export async function recentActivity(source: ActivitySource | undefined, hours: unknown, repository?: unknown): Promise<Result<Activity>> {
  if (!source) return { ok: true, value: { enabled: false } };
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) {
    return { ok: false, status: 422, message: `hours must be a whole number from 1 to ${MAX_HOURS}` };
  }
  let only: string | undefined;
  if (repository !== undefined) {
    const repo = parseRepository(repository);
    if (!repo) return { ok: false, status: 422, message: "Enter a repository as owner/name" };
    only = `${repo.owner}/${repo.name}`.toLowerCase();
  }
  try {
    return { ok: true, value: { enabled: true, hours, repositories: await source.byRepository(hours, only) } };
  } catch (err) {
    return { ok: false, status: 502, message: err instanceof Error ? err.message : String(err) };
  }
}
