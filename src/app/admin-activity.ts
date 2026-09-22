import { parseRepository } from "./admin-locks.ts";
import type { Result } from "./lfs.ts";
import type { ActivitySource, RequestTotals } from "./ports.ts";

/** Analytics Engine keeps data points for three months. */
const MAX_HOURS = 24 * 90;

/** Repositories listed at most, those with the most requests. */
export const ACTIVITY_REPOSITORIES = 200;

export type Activity =
  | { enabled: false }
  | {
      enabled: true;
      hours: number;
      repositories: ({ repo: string } & RequestTotals)[];
      /** True when there may be more repositories than `repositories` lists. */
      truncated: boolean;
      total: RequestTotals;
      /** Every bucket of the period, oldest first, including those without requests. */
      timeline: ({ start: string } & RequestTotals)[];
      bucketHours: number;
    };

/** Wide enough buckets that a period has at most about 170 of them. */
export function bucketHoursFor(hours: number): number {
  if (hours <= 24 * 7) return 1;
  if (hours <= 24 * 30) return 6;
  return 24;
}

const HOUR_MS = 3600_000;

/** The buckets from the one holding `now - hours` to the one holding `now`, with zeros where nothing was recorded. */
export function fillTimeline(
  rows: readonly ({ start: string } & RequestTotals)[],
  hours: number,
  bucketHours: number,
  now: Date,
): ({ start: string } & RequestTotals)[] {
  const size = bucketHours * HOUR_MS;
  const byStart = new Map(rows.map((row) => [Date.parse(row.start), row]));
  const first = Math.floor((now.getTime() - hours * HOUR_MS) / size) * size;
  const buckets: ({ start: string } & RequestTotals)[] = [];
  for (let start = first; start <= now.getTime(); start += size) {
    const row = byStart.get(start);
    buckets.push({ start: new Date(start).toISOString(), requests: row?.requests ?? 0, bytes: row?.bytes ?? 0, errors: row?.errors ?? 0 });
  }
  return buckets;
}

const sum = (rows: readonly RequestTotals[]): RequestTotals =>
  rows.reduce((t, r) => ({ requests: t.requests + r.requests, bytes: t.bytes + r.bytes, errors: t.errors + r.errors }), {
    requests: 0,
    bytes: 0,
    errors: 0,
  });

/** Requests in the last `hours` by repository and over time, or only those of `repository` when it is given. */
export async function recentActivity(
  source: ActivitySource | undefined,
  hours: unknown,
  repository?: unknown,
  now: () => Date = () => new Date(),
): Promise<Result<Activity>> {
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
  const bucketHours = bucketHoursFor(hours);
  try {
    const [repositories, timeline] = await Promise.all([
      source.byRepository(hours, only, ACTIVITY_REPOSITORIES),
      source.timeline(hours, bucketHours, only),
    ]);
    return {
      ok: true,
      value: {
        enabled: true,
        hours,
        repositories,
        truncated: repositories.length >= ACTIVITY_REPOSITORIES,
        // From the timeline, which covers every repository even when the list stops at its limit.
        total: sum(timeline),
        timeline: fillTimeline(timeline, hours, bucketHours, now()),
        bucketHours,
      },
    };
  } catch (err) {
    return { ok: false, status: 502, message: err instanceof Error ? err.message : String(err) };
  }
}
