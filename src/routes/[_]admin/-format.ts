// Formatting and small helpers for the admin UI, free of React and the DOM so that tests can run them in the Worker.

/** `owner/name` split for a route's params; undefined for anything else, such as an empty repository in metrics. */
export function splitRepository(repo: string): { owner: string; name: string } | undefined {
  const [owner, name, ...rest] = repo.split("/");
  return owner && name && rest.length === 0 ? { owner, name } : undefined;
}

/** `items` in runs of at most `size`, in order. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let i = 0; i < items.length; i += size) runs.push(items.slice(i, i + size));
  return runs;
}

export type SortDirection = "ascending" | "descending";

/** `rows` ordered by `key`: numbers by value, anything else as text; ties keep their order. */
export function sortRows<T>(rows: readonly T[], key: keyof T, direction: SortDirection): T[] {
  const sign = direction === "ascending" ? 1 : -1;
  return rows.toSorted((a, b) => {
    const x = a[key];
    const y = b[key];
    const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sign * order;
  });
}

/** The share of requests that failed with a server error, as `1.5%`. */
export const errorRate = (errors: number, requests: number) => (requests ? `${((errors / requests) * 100).toFixed(1)}%` : "–");

/** Share of the quota used, from 0; undefined without a quota. */
export function quotaShare(bytes: number, quota: number | undefined): number | undefined {
  return quota ? bytes / quota : undefined;
}

/** Past this share of its quota a repository is shown as nearly full. */
export const QUOTA_WARNING = 0.8;

/** Whether `iso` lies more than `days` before `now`. */
export function olderThan(iso: string, days: number, now: number): boolean {
  return now - new Date(iso).getTime() > days * 24 * 3600 * 1000;
}

/**
 * Repositories to suggest where one is typed: the patterns of ALLOWED_REPOS that name a single repository, and the
 * repositories a storage count found, without repeats.
 */
export function repositoryChoices(allowedRepos: readonly string[], counted: readonly string[]): string[] {
  const exact = allowedRepos.filter((pattern) => !pattern.includes("*"));
  return [...new Set([...exact, ...counted])].toSorted();
}

/** How many results ended each way, most frequent first. */
export function countOutcomes(results: readonly { outcome: string }[]): { outcome: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { outcome } of results) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  return [...counts].map(([outcome, count]) => ({ outcome, count })).toSorted((a, b) => b.count - a.count);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * One locale for every number and date, so the Worker's render (in UTC, with no browser locale) and the browser's
 * hydration produce the same text.
 */
const LOCALE = "en";

export const formatCount = (n: number) => new Intl.NumberFormat(LOCALE).format(Math.round(n));

/** `2026-09-14 08:05 UTC`: the same wherever it is rendered. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** `3 days ago`, relative to `now`. */
export function formatRelative(iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const format = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.trunc(seconds / size), unit);
  }
  return format.format(0, "minute");
}
