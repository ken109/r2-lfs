import { UsageError } from "../domain/errors.ts";
import { oidOfKey, type StoredObject } from "../domain/objects.ts";
import { type Decision, planObjects } from "../domain/plan.ts";
import { collectFacts, loadPolicy, presence, resolveLayout } from "./common.ts";
import type { ObjectStorage, GitRepository, LfsClient, Reporter } from "./ports.ts";

export interface WhyDeps {
  repo: GitRepository;
  client: LfsClient;
  reporter: Reporter;
  storage?: ObjectStorage;
}

export interface ExplainedObject {
  oid: string;
  size: number;
  paths: string[];
  lastCommitted?: Date;
  /** Known only with bucket access. */
  uploaded?: Date;
  storageClass?: string;
  onServer: boolean;
  inTrash: boolean;
  decision: Decision;
}

export interface Explanation {
  /** Set when the target was a path; objects are then its versions, newest first. */
  path?: string;
  objects: ExplainedObject[];
}

const OID_PREFIX = /^[0-9a-f]{6,64}$/;

/** `target` is a repository-relative path or an oid prefix. */
export async function explain(deps: WhyDeps, target: string, opts: { layout?: string; now?: Date } = {}): Promise<Explanation> {
  const { repo, client, reporter } = deps;
  const policy = loadPolicy(repo);
  const now = opts.now ?? new Date();
  const facts = await reporter.task("Reading git history", () => collectFacts(repo, policy, now));

  let path: string | undefined;
  let oids: string[];
  if (facts.history.versions.has(target)) {
    path = target;
    oids = facts.history.versions.get(target)!.map((v) => v.oid);
  } else if (OID_PREFIX.test(target)) {
    oids = [...facts.paths.keys()].filter((oid) => oid.startsWith(target));
    if (oids.length === 0) throw new UsageError(`no LFS object in history starts with ${target}`);
    if (oids.length > 1) throw new UsageError(`${target} is ambiguous: ${oids.map((o) => o.slice(0, 10)).join(", ")}`);
  } else {
    throw new UsageError(`${target} has never been stored in LFS, and is not an oid`);
  }

  const sizes = facts.history.sizes;
  const state = await reporter.task("Asking the server", () =>
    presence(
      client,
      oids.map((oid) => ({ oid, size: sizes.get(oid) ?? 0 })),
    ),
  );

  const stored = new Map<string, StoredObject>();
  const trashed = new Set<string>();
  if (deps.storage) {
    const layout = await resolveLayout(client, opts.layout);
    for (const object of await deps.storage.list("live", layout)) stored.set(oidOfKey(object.key) ?? "", object);
    for (const object of await deps.storage.list("trash", layout)) trashed.add(oidOfKey(object.key) ?? "");
  }

  const objects = oids.map((oid): ExplainedObject => {
    const listed = stored.get(oid);
    // Without bucket access the upload date is unknown, so the object is judged as if it were old.
    const object = listed ?? { key: oid, size: sizes.get(oid) ?? 0, lastModified: new Date(0), storageClass: "STANDARD" };
    const [planned] = planObjects([object], facts, policy, now);
    const times = [...(facts.paths.get(oid) ?? [])].map((p) => facts.history.versions.get(p)?.find((v) => v.oid === oid)?.time ?? 0);
    const newest = Math.max(0, ...times);
    return {
      oid,
      size: object.size,
      paths: planned!.paths,
      ...(newest > 0 ? { lastCommitted: new Date(newest * 1000) } : {}),
      ...(listed ? { uploaded: listed.lastModified, storageClass: listed.storageClass } : {}),
      onServer: state.get(oid) === "stored",
      inTrash: trashed.has(oid),
      decision: planned!.decision,
    };
  });
  return { ...(path ? { path } : {}), objects };
}
