import { parse } from "smol-toml";

import { UsageError } from "./errors.ts";

export const POLICY_FILE = ".r2-lfs.toml";

export type OldVersions = "delete" | "infrequent-access";

export interface Rule {
  path: string;
  keepDays?: number;
  keepVersions?: number;
  keepAll?: boolean;
  oldVersions?: OldVersions;
}

export interface Policy {
  keepDays: number;
  keepVersions: number;
  minAgeDays: number;
  oldVersions: OldVersions;
  rules: Rule[];
}

export interface Effective {
  keepDays: number;
  keepVersions: number;
  keepAll: boolean;
  oldVersions: OldVersions;
  /** The rule's path pattern, or undefined for the defaults. */
  rule: string | undefined;
}

export const DEFAULT_POLICY: Policy = {
  keepDays: 90,
  keepVersions: 0,
  minAgeDays: 30,
  oldVersions: "delete",
  rules: [],
};

function nonNegative(value: unknown, where: string, problems: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  problems.push(`${where} must be a non-negative integer`);
  return undefined;
}

function oldVersions(value: unknown, where: string, problems: string[]): OldVersions | undefined {
  if (value === undefined) return undefined;
  if (value === "delete" || value === "infrequent-access") return value;
  problems.push(`${where} must be "delete" or "infrequent-access"`);
  return undefined;
}

const TOP_KEYS = new Set(["keep_days", "keep_versions", "min_age_days", "old_versions", "rule"]);
const RULE_KEYS = new Set(["path", "keep_days", "keep_versions", "keep", "old_versions"]);

/**
 * ```toml
 * keep_days = 90            # keep objects used by commits from the last 90 days
 * keep_versions = 0         # also keep the newest N versions of every file
 * min_age_days = 30         # never touch objects uploaded more recently
 * old_versions = "delete"   # or "infrequent-access"
 *
 * [[rule]]                  # first matching rule wins
 * path = "textures/**"
 * keep_versions = 3
 * ```
 */
export function parsePolicy(text: string | undefined): Policy {
  if (text === undefined) return { ...DEFAULT_POLICY, rules: [] };
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new UsageError(`${POLICY_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const problems: string[] = [];
  for (const key of Object.keys(doc)) if (!TOP_KEYS.has(key)) problems.push(`unknown setting "${key}"`);

  const policy: Policy = {
    keepDays: nonNegative(doc.keep_days, "keep_days", problems) ?? DEFAULT_POLICY.keepDays,
    keepVersions: nonNegative(doc.keep_versions, "keep_versions", problems) ?? DEFAULT_POLICY.keepVersions,
    minAgeDays: nonNegative(doc.min_age_days, "min_age_days", problems) ?? DEFAULT_POLICY.minAgeDays,
    oldVersions: oldVersions(doc.old_versions, "old_versions", problems) ?? DEFAULT_POLICY.oldVersions,
    rules: [],
  };

  const rules = doc.rule ?? [];
  if (!Array.isArray(rules)) problems.push("rules must be written as [[rule]] tables");
  else {
    for (const [i, entry] of rules.entries()) {
      const raw = entry as Record<string, unknown>;
      const where = `rule #${i + 1}`;
      for (const key of Object.keys(raw)) if (!RULE_KEYS.has(key)) problems.push(`${where}: unknown setting "${key}"`);
      if (typeof raw.path !== "string" || !raw.path) {
        problems.push(`${where}: path is required`);
        continue;
      }
      if (raw.keep !== undefined && raw.keep !== "all") problems.push(`${where}: keep can only be "all"`);
      policy.rules.push({
        path: raw.path,
        keepDays: nonNegative(raw.keep_days, `${where}: keep_days`, problems),
        keepVersions: nonNegative(raw.keep_versions, `${where}: keep_versions`, problems),
        keepAll: raw.keep === "all" || undefined,
        oldVersions: oldVersions(raw.old_versions, `${where}: old_versions`, problems),
      });
    }
  }

  if (problems.length > 0) throw new UsageError(`${POLICY_FILE}:\n  - ${problems.join("\n  - ")}`);
  return policy;
}

const globCache = new Map<string, RegExp>();

/**
 * gitattributes-style matching: a pattern without a slash matches a file name at any depth,
 * a pattern with one is relative to the repository root. `**` spans directories.
 */
export function globMatch(pattern: string, path: string): boolean {
  let regex = globCache.get(pattern);
  if (!regex) {
    let p = pattern.replace(/^\//, "");
    if (p.endsWith("/")) p += "**";
    const anchored = pattern.includes("/");
    let source = "";
    for (let i = 0; i < p.length; i++) {
      const c = p[i]!;
      if (c === "*" && p[i + 1] === "*") {
        const slash = p[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else if (c === "*") source += "[^/]*";
      else if (c === "?") source += "[^/]";
      else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    regex = new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`);
    globCache.set(pattern, regex);
  }
  return regex.test(path);
}

export function effectiveFor(policy: Policy, path: string | undefined): Effective {
  const rule = path === undefined ? undefined : policy.rules.find((r) => globMatch(r.path, path));
  return {
    keepDays: rule?.keepDays ?? policy.keepDays,
    keepVersions: rule?.keepVersions ?? policy.keepVersions,
    keepAll: rule?.keepAll ?? false,
    oldVersions: rule?.oldVersions ?? policy.oldVersions,
    rule: rule?.path,
  };
}

/** Every distinct keep_days value, so history is scanned once per window. */
export function keepDayWindows(policy: Policy): number[] {
  return [...new Set([policy.keepDays, ...policy.rules.map((r) => r.keepDays ?? policy.keepDays)])].toSorted((a, b) => a - b);
}
