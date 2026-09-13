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
      // git would match nothing, which would silently drop the rule and apply the defaults instead.
      if (!compileGlob(raw.path)) problems.push(`${where}: path "${raw.path}" is not a valid pattern`);
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

const globCache = new Map<string, RegExp | undefined>();

/** POSIX classes allowed inside brackets, as in `[[:digit:]]`. */
const POSIX_CLASSES: Record<string, string> = {
  alnum: "A-Za-z0-9",
  alpha: "A-Za-z",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "\\x21-\\x7e",
  lower: "a-z",
  print: "\\x20-\\x7e",
  punct: "\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e",
  space: " \\t\\n\\r\\f\\v",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f",
};

/** A `[...]` class starting at `start`, as a regular expression, or `invalid` for an unknown POSIX class or a missing `]`. */
function bracketClass(p: string, start: number): { source: string; end: number } | "invalid" {
  let i = start + 1;
  const negate = p[i] === "!" || p[i] === "^";
  if (negate) i++;
  let body = "";
  // A `]` right after the opening bracket is a member, not the end.
  for (let first = true; i < p.length; i++, first = false) {
    const c = p[i]!;
    // Paths are matched as path names, so no class matches `/`, negated or not.
    if (c === "]" && !first) return { source: negate ? `(?!/)[^${body}]` : `(?!/)[${body}]`, end: i };
    if (c === "[" && p[i + 1] === ":") {
      const close = p.indexOf(":]", i + 2);
      if (close !== -1) {
        const members = POSIX_CLASSES[p.slice(i + 2, close)];
        if (members === undefined) return "invalid";
        body += members;
        i = close + 1;
        continue;
      }
    }
    // A backslash makes the next character a plain member, even `]` or `-`.
    const escaped = c === "\\" && i + 1 < p.length;
    const member = escaped ? p[++i]! : c;
    body += /[\\\]^[]/.test(member) || (escaped && member === "-") ? `\\${member}` : member;
  }
  return "invalid";
}

/**
 * gitattributes-style matching: a pattern without a slash matches a file name at any depth,
 * a pattern with one is relative to the repository root. `**` spans directories; `[...]` is a character class.
 * A backslash makes the next character literal. Returns undefined for a pattern that cannot be translated:
 * an unknown POSIX class such as `[[:Digit:]]`, a missing `]`, a trailing backslash or a range out of order.
 */
export function compileGlob(pattern: string): RegExp | undefined {
  if (globCache.has(pattern)) return globCache.get(pattern);
  let p = pattern.replace(/^\//, "");
  if (p.endsWith("/")) p += "**";
  const anchored = pattern.includes("/");
  let source = "";
  let regex: RegExp | undefined;
  let valid = true;
  for (let i = 0; i < p.length && valid; i++) {
    const c = p[i]!;
    const cls = c === "[" ? bracketClass(p, i) : undefined;
    if (cls === "invalid" || (c === "\\" && i + 1 === p.length)) valid = false;
    else if (c === "\\") source += p[++i]!.replace(/[.*?+^${}()|[\]\\]/g, "\\$&");
    // `**` spans directories only as a whole segment; elsewhere, as in `a**b`, it is just `*`.
    else if (c === "*" && p[i + 1] === "*" && (i === 0 || p[i - 1] === "/") && (i + 2 === p.length || p[i + 2] === "/")) {
      const slash = p[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (cls) {
      source += cls.source;
      i = cls.end;
    } else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  if (valid) {
    try {
      regex = new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`);
    } catch {
      regex = undefined;
    }
  }
  globCache.set(pattern, regex);
  return regex;
}

/** Whether `path` matches `pattern`; a pattern that cannot be translated matches nothing. */
export function globMatch(pattern: string, path: string): boolean {
  return compileGlob(pattern)?.test(path) ?? false;
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
