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
