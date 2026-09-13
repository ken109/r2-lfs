// Pure parts of the garbage collector, kept free of Node APIs so they run in the test pool.

export interface StoredObject {
  key: string;
  size: number;
  lastModified: Date;
}

const POINTER_OID = /^oid sha256:([0-9a-f]{64})$/m;

/** Returns the oid if `content` is a Git LFS pointer file. */
export function parsePointer(content: string): string | undefined {
  if (!content.startsWith("version https://git-lfs.github.com/spec/v1\n")) return undefined;
  return POINTER_OID.exec(content)?.[1];
}

function decodeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Parses one page of an S3 ListObjectsV2 response. */
export function parseListObjects(xml: string): { objects: StoredObject[]; nextToken: string | undefined } {
  const objects: StoredObject[] = [];
  for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body!)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(body!)?.[1];
    const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(body!)?.[1];
    if (key === undefined || size === undefined || modified === undefined) continue;
    objects.push({ key: decodeXml(key), size: Number(size), lastModified: new Date(modified) });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, nextToken: truncated && token ? decodeXml(token) : undefined };
}

export interface Plan {
  keep: StoredObject[];
  /** Unreferenced, but uploaded too recently to delete safely. */
  young: StoredObject[];
  delete: StoredObject[];
  /** Keys under the prefix that are not LFS objects; never touched. */
  foreign: StoredObject[];
}

export function planDeletions(
  stored: readonly StoredObject[],
  referenced: ReadonlySet<string>,
  minAgeDays: number,
  now: Date,
): Plan {
  const cutoff = now.getTime() - minAgeDays * 86_400_000;
  const plan: Plan = { keep: [], young: [], delete: [], foreign: [] };
  for (const object of stored) {
    const oid = object.key.slice(object.key.lastIndexOf("/") + 1);
    if (!/^[0-9a-f]{64}$/.test(oid)) plan.foreign.push(object);
    else if (referenced.has(oid)) plan.keep.push(object);
    else if (object.lastModified.getTime() > cutoff) plan.young.push(object);
    else plan.delete.push(object);
  }
  return plan;
}
