// Deletes LFS objects that no recent commit references.
//
//   pnpm gc --repo ../my-repo                      # dry run, per-repo layout
//   pnpm gc --repo ../my-repo --apply              # actually delete
//   pnpm gc --shared --repo ../a --repo ../b       # shared layout: list every repo using the bucket
//
// Needs R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in the environment
// (R2_ENDPOINT optionally overrides the S3 endpoint).
// The R2 API token needs Object Read & Write on the bucket.

import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { AwsClient } from "aws4fetch";
import { parsePointer, parseListObjects, planDeletions, type StoredObject } from "./gc/select.ts";

const { values } = parseArgs({
  options: {
    repo: { type: "string", multiple: true },
    shared: { type: "boolean", default: false },
    "keep-days": { type: "string", default: "90" },
    "min-age-days": { type: "string", default: "30" },
    "no-fetch": { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const USAGE = `Usage: pnpm gc --repo <path> [--repo <path> ...] [options]

Keeps every object referenced by a ref tip or by a commit from the last --keep-days days,
across all local and remote-tracking refs. Deletes the rest once they are older than
--min-age-days. Dry run unless --apply is given.

Options:
  --repo <path>          Local clone to scan (repeat for --shared)
  --shared               Bucket uses STORAGE_LAYOUT=shared; pass every repository that uses it
  --keep-days <n>        Keep objects referenced by commits newer than this (default 90)
  --min-age-days <n>     Never delete objects uploaded more recently than this (default 30)
  --no-fetch             Skip "git fetch --all" before scanning
  --apply                Delete for real
`;

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const repos = values.repo ?? [];
if (repos.length === 0) fail("--repo is required");
if (!values.shared && repos.length > 1) fail("per-repo layout takes exactly one --repo; did you mean --shared?");

const keepDays = Number(values["keep-days"]);
const minAgeDays = Number(values["min-age-days"]);
if (!(keepDays >= 0) || !(minAgeDays >= 0)) fail("--keep-days and --min-age-days must be non-negative numbers");

const env = {
  accountId: process.env.R2_ACCOUNT_ID,
  bucket: process.env.R2_BUCKET_NAME,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
};
const missingEnv = Object.entries({
  R2_ACCOUNT_ID: env.accountId,
  R2_BUCKET_NAME: env.bucket,
  R2_ACCESS_KEY_ID: env.accessKeyId,
  R2_SECRET_ACCESS_KEY: env.secretAccessKey,
})
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missingEnv.length > 0) fail(`missing environment variables: ${missingEnv.join(", ")}`);

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
}

/** Reads `lfs.url` and returns the `<owner>/<repo>/` prefix the Worker stores objects under. */
function perRepoPrefix(repo: string): string {
  const read = (args: string[]) =>
    spawnSync("git", ["-C", repo, "config", ...args, "lfs.url"], { encoding: "utf8" }).stdout.trim();
  const url = (read([]) || read(["-f", ".lfsconfig"])).replace(/\/+$/, "");
  if (!url) fail(`${repo} has no lfs.url (neither in git config nor .lfsconfig)`);
  const match = /\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/info\/lfs)?$/.exec(url);
  if (!match) fail(`cannot derive <owner>/<repo> from lfs.url "${url}" in ${repo}`);
  return `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}/`;
}

function referencedOids(repo: string): Set<string> {
  if (!values["no-fetch"]) {
    console.error(`fetching ${repo} ...`);
    git(repo, ["fetch", "--all", "--prune", "--quiet"]);
  }

  const since = Math.floor(Date.now() / 1000 - keepDays * 86_400);
  const commits = new Set(
    git(repo, ["rev-list", "--all", `--since=${since}`]).split("\n").filter(Boolean),
  );
  // Ref tips are kept however old they are: they are what a fresh clone checks out.
  for (const line of git(repo, ["for-each-ref", "--format=%(objectname) %(objecttype) %(*objectname) %(*objecttype)"]).split("\n")) {
    const [id, type, peeled, peeledType] = line.split(" ");
    if (type === "commit" && id) commits.add(id);
    else if (peeledType === "commit" && peeled) commits.add(peeled);
  }

  // LFS pointers are tiny, so only small blobs need to be read.
  const blobs = new Set<string>();
  for (const commit of commits) {
    for (const entry of git(repo, ["ls-tree", "-r", "-l", "-z", commit]).split("\0")) {
      const match = /^\d+ blob ([0-9a-f]+)\s+(\d+)\t/.exec(entry);
      if (match && Number(match[2]) < 1024) blobs.add(match[1]!);
    }
  }

  const oids = new Set<string>();
  if (blobs.size === 0) return oids;
  // Read as bytes: small non-pointer blobs may be binary, which would skew string offsets.
  const output = execFileSync("git", ["-C", repo, "cat-file", "--batch"], {
    input: [...blobs].join("\n") + "\n",
    maxBuffer: 1024 * 1024 * 1024,
  });
  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    const [, type, sizeText] = output.toString("latin1", offset, headerEnd).split(" ");
    if (type !== "blob") {
      offset = headerEnd + 1;
      continue;
    }
    const size = Number(sizeText);
    const oid = parsePointer(output.toString("latin1", headerEnd + 1, headerEnd + 1 + size));
    if (oid) oids.add(oid);
    offset = headerEnd + 1 + size + 1;
  }
  console.error(`${repo}: ${commits.size} commits, ${oids.size} referenced objects`);
  return oids;
}

const client = new AwsClient({
  accessKeyId: env.accessKeyId!,
  secretAccessKey: env.secretAccessKey!,
  service: "s3",
  region: "auto",
});
// R2_ENDPOINT overrides the host, e.g. https://<account>.eu.r2.cloudflarestorage.com for EU buckets.
const endpoint = `${(process.env.R2_ENDPOINT ?? `https://${env.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, "")}/${env.bucket}`;

async function listObjects(prefix: string): Promise<StoredObject[]> {
  const all: StoredObject[] = [];
  let token: string | undefined;
  do {
    const url = new URL(endpoint);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (token) url.searchParams.set("continuation-token", token);
    const res = await client.fetch(url);
    if (!res.ok) throw new Error(`ListObjectsV2 failed: ${res.status} ${await res.text()}`);
    const page = parseListObjects(await res.text());
    all.push(...page.objects);
    token = page.nextToken;
  } while (token);
  return all;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const total = (objects: StoredObject[]) => formatBytes(objects.reduce((sum, o) => sum + o.size, 0));

const prefix = values.shared ? "_shared/" : perRepoPrefix(repos[0]!);
const referenced = new Set<string>();
for (const repo of repos) for (const oid of referencedOids(repo)) referenced.add(oid);

const stored = await listObjects(prefix);
const plan = planDeletions(stored, referenced, minAgeDays, new Date());

console.log(`bucket ${env.bucket}, prefix ${prefix}`);
console.log(`  keep     ${plan.keep.length} objects, ${total(plan.keep)}`);
console.log(`  too new  ${plan.young.length} objects, ${total(plan.young)} (unreferenced, uploaded < ${minAgeDays} days ago)`);
console.log(`  delete   ${plan.delete.length} objects, ${total(plan.delete)}`);
if (plan.foreign.length > 0) console.log(`  ignored  ${plan.foreign.length} keys that are not LFS objects`);

if (!values.apply) {
  for (const object of plan.delete) {
    console.log(`  would delete ${object.key} (${formatBytes(object.size)}, ${object.lastModified.toISOString()})`);
  }
  console.log("\nDry run. Re-run with --apply to delete.");
  process.exit(0);
}

let deleted = 0;
const refused: string[] = [];
for (const object of plan.delete) {
  const res = await client.fetch(`${endpoint}/${object.key}`, { method: "DELETE" });
  if (res.ok) deleted++;
  else refused.push(`${object.key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}
console.log(`\ndeleted ${deleted} of ${plan.delete.length}`);
if (refused.length > 0) {
  // Bucket lock rules make R2 refuse deletes inside the retention window.
  console.log(`refused ${refused.length} (a bucket lock rule may still protect them):`);
  for (const line of refused) console.log(`  ${line}`);
  process.exit(2);
}
