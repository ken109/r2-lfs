import * as v from "valibot";

import type { Permission } from "./access.ts";
import { BatchEntry, JsonObject, ObjectSpec as ObjectSpecSchema, Operation, read } from "./requests.ts";

export const MAX_OBJECTS_PER_BATCH = 1000;

export type Operation = "upload" | "download";

export interface ObjectSpec {
  oid: string;
  size: number;
}

/** A failure the LFS client should see, with the HTTP status the spec prescribes. */
export interface Rejection {
  status: number;
  message: string;
}

export type Parsed<T> = { ok: true; value: T } | ({ ok: false } & Rejection);

/** The object `raw` names, or undefined when its oid or size is invalid. */
export function objectSpec(raw: unknown): ObjectSpec | undefined {
  return read(ObjectSpecSchema, raw);
}

export interface BatchRequest {
  operation: Operation;
  /** Entries as sent; invalid ones are reported per object rather than failing the batch. */
  objects: { oid: unknown; size: unknown }[];
  /** Transfer adapters the client offers; git-lfs always includes basic. */
  transfers: string[];
}

const BatchObjects = v.pipe(v.array(v.unknown()), v.maxLength(MAX_OBJECTS_PER_BATCH));

export function parseBatchRequest(body: unknown): Parsed<BatchRequest> {
  // JSON arrays are objects too, but not what a batch request is.
  if (!v.is(JsonObject, body) || Array.isArray(body)) {
    return { ok: false, status: 400, message: "Request body must be a JSON object" };
  }
  const { operation, objects, hash_algo, transfers } = body;
  if (!v.is(Operation, operation)) return { ok: false, status: 422, message: "operation must be upload or download" };
  if (hash_algo !== undefined && hash_algo !== "sha256") return { ok: false, status: 409, message: "Only sha256 is supported" };
  if (!v.is(BatchObjects, objects)) {
    return { ok: false, status: 422, message: `objects must be an array of at most ${MAX_OBJECTS_PER_BATCH} entries` };
  }
  return {
    ok: true,
    value: {
      operation,
      objects: objects.map((o) => (v.is(BatchEntry, o) ? { oid: o.oid, size: o.size } : { oid: undefined, size: undefined })),
      transfers: Array.isArray(transfers) ? transfers.filter((t): t is string => typeof t === "string") : ["basic"],
    },
  };
}

export function parseObjectSpec(body: unknown): Parsed<ObjectSpec> {
  const spec = objectSpec(body);
  return spec ? { ok: true, value: spec } : { ok: false, status: 422, message: "Invalid oid or size" };
}

export function requiredPermission(operation: Operation): Permission {
  return operation === "upload" ? "write" : "read";
}

/** R2 accepts at most 5 GiB minus 5 MiB in one request, and git-lfs's basic transfer uploads an object in one PUT. */
export const R2_MAX_SINGLE_UPLOAD_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;

export type UploadDecision =
  | { kind: "exists" }
  | { kind: "too-large"; limitBytes: number; presigned: boolean }
  | { kind: "over-limit"; limitBytes: number }
  | { kind: "upload" };

export function decideUpload(
  object: ObjectSpec,
  stored: { size: number } | null,
  transfer: { presigned: boolean; proxyMaxUploadBytes: number; maxObjectBytes?: number; multipart?: boolean },
  /** Whether this repository has uploaded the stored object; always true outside the shared layout. */
  member = true,
): UploadDecision {
  // In the shared layout a repository proves it has the content by uploading it, before it may read it.
  if (stored && stored.size === object.size && member) return { kind: "exists" };
  if (transfer.maxObjectBytes !== undefined && object.size > transfer.maxObjectBytes) {
    return { kind: "over-limit", limitBytes: transfer.maxObjectBytes };
  }
  // Multipart uploads are only bounded by R2's object size.
  if (transfer.multipart) return { kind: "upload" };
  const limitBytes = transfer.presigned ? R2_MAX_SINGLE_UPLOAD_BYTES : transfer.proxyMaxUploadBytes;
  if (object.size > limitBytes) return { kind: "too-large", limitBytes, presigned: transfer.presigned };
  return { kind: "upload" };
}

/** Keeps uploads in the batch that still fit the quota, in order; the rest get a 507. */
export function applyQuota<T extends { size: number; upload: boolean }>(
  objects: readonly T[],
  usedBytes: number,
  quotaBytes: number,
): boolean[] {
  let used = usedBytes;
  return objects.map((object) => {
    if (!object.upload) return true;
    if (used + object.size > quotaBytes) return false;
    used += object.size;
    return true;
  });
}

export function tooLargeMessage(decision: { limitBytes: number; presigned: boolean }): string {
  const limitMb = Math.floor(decision.limitBytes / 1024 / 1024);
  return decision.presigned
    ? `Object is larger than ${limitMb} MB, the most R2 accepts in one upload. Run \`r2-lfs transfer-agent --install\` to upload it in parts.`
    : `Object is larger than ${limitMb} MB, the proxy upload limit. Run \`r2-lfs transfer-agent --install\` to upload it in parts, or configure presigned URLs (R2_ACCESS_KEY_ID etc.).`;
}
