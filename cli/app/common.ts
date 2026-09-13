import { repoPrefix, type ServerInfo, type StorageLayout, TRASH_PREFIX } from "../../src/shared/contract.ts";
import { UsageError } from "../domain/errors.ts";
import { addPath, buildHistory, type History } from "../domain/history.ts";
import type { ObjectRef } from "../domain/objects.ts";
import type { Facts } from "../domain/plan.ts";
import { keepDayWindows, POLICY_FILE, type Policy, parsePolicy } from "../domain/policy.ts";
import type { GitRepository, LfsClient } from "./ports.ts";

export async function requireServerInfo(client: LfsClient): Promise<ServerInfo> {
  const result = await client.info();
  if (result.kind === "misconfigured") throw new UsageError(`the server is misconfigured:\n- ${result.problems.join("\n- ")}`);
  if (result.kind === "not-r2-lfs")
    throw new UsageError(`${client.location.origin} did not answer like an r2-lfs server (status ${result.status})`);
  return result.info;
}

/** Uses `override` when given, otherwise asks the server. */
export async function resolveLayout(client: LfsClient, override: string | undefined): Promise<StorageLayout> {
  if (override !== undefined) {
    if (override !== "per-repo" && override !== "shared") throw new UsageError('--layout must be "per-repo" or "shared"');
    return override;
  }
  try {
    return (await requireServerInfo(client)).storageLayout;
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`cannot reach ${client.location.origin} to learn its storage layout; pass --layout per-repo|shared`);
  }
}

export function livePrefix(client: LfsClient, layout: StorageLayout): string {
  return repoPrefix(layout, client.location.owner, client.location.repo);
}

export function trashPrefix(client: LfsClient, layout: StorageLayout): string {
  return `${TRASH_PREFIX}${livePrefix(client, layout)}`;
}

export interface PolicyOverrides {
  keepDays?: string;
  keepVersions?: string;
  minAgeDays?: string;
}

/** Parses a `--<flag>` count of days. */
export function readDays(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${flag} must be a non-negative integer`);
  return n;
}

export function loadPolicy(repo: GitRepository, overrides: PolicyOverrides = {}): Policy {
  const policy = parsePolicy(repo.readFile(POLICY_FILE));
  policy.keepDays = readDays("keep-days", overrides.keepDays) ?? policy.keepDays;
  policy.keepVersions = readDays("keep-versions", overrides.keepVersions) ?? policy.keepVersions;
  policy.minAgeDays = readDays("min-age-days", overrides.minAgeDays) ?? policy.minAgeDays;
  return policy;
}

export function readHistory(repo: GitRepository): History {
  return buildHistory(repo.pointerHistory());
}

export function collectFacts(repo: GitRepository, policy: Policy, now: Date): Facts & { history: History } {
  const history = readHistory(repo);

  const tipObjects = repo.pointersIn(repo.refTips());
  for (const [oid, at] of tipObjects) for (const path of at.paths) addPath(history.paths, oid, path);

  const windows = new Map<number, Set<string>>();
  const days = keepDayWindows(policy);
  const nowUnix = Math.floor(now.getTime() / 1000);
  const recent = repo.commitsSince(nowUnix - Math.max(...days) * 86_400);
  for (const d of days) {
    const since = nowUnix - d * 86_400;
    const objects = repo.pointersIn(recent.filter((c) => c.time >= since).map((c) => c.sha));
    windows.set(d, new Set(objects.keys()));
    for (const [oid, at] of objects) for (const path of at.paths) addPath(history.paths, oid, path);
  }

  const versions = new Map([...history.versions].map(([path, list]) => [path, list.map((v) => v.oid)]));
  return { paths: history.paths, tips: new Set(tipObjects.keys()), windows, versions, history };
}

/** Which objects the server has. Uses download batches, so read access is enough. */
export async function presence(client: LfsClient, objects: ObjectRef[]): Promise<Map<string, "stored" | "missing">> {
  const state = new Map<string, "stored" | "missing">();
  for (const result of await client.batch("download", objects)) {
    state.set(result.oid, result.error ? "missing" : "stored");
  }
  return state;
}
