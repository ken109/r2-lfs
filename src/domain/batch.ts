import { OID_PATTERN } from "../shared/contract.ts";
import type { Permission } from "./access.ts";

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

export function isValidObject(oid: unknown, size: unknown): boolean {
  return typeof oid === "string" && OID_PATTERN.test(oid) && typeof size === "number" && Number.isSafeInteger(size) && size >= 0;
}

export interface BatchRequest {
  operation: Operation;
  /** Entries as sent; invalid ones are reported per object rather than failing the batch. */
  objects: { oid: unknown; size: unknown }[];
}

export function parseBatchRequest(body: unknown): Parsed<BatchRequest> {
  if (typeof body !== "object" || body === null) return { ok: false, status: 400, message: "Request body must be a JSON object" };
  const { operation, objects, hash_algo } = body as Record<string, unknown>;
  if (operation !== "upload" && operation !== "download") {
    return { ok: false, status: 422, message: "operation must be upload or download" };
  }
  if (hash_algo !== undefined && hash_algo !== "sha256") return { ok: false, status: 409, message: "Only sha256 is supported" };
  if (!Array.isArray(objects) || objects.length > MAX_OBJECTS_PER_BATCH) {
    return { ok: false, status: 422, message: `objects must be an array of at most ${MAX_OBJECTS_PER_BATCH} entries` };
  }
  return {
    ok: true,
    value: {
      operation,
      objects: objects.map((o) => ({ oid: (o as { oid?: unknown } | null)?.oid, size: (o as { size?: unknown } | null)?.size })),
    },
  };
}

export function parseObjectSpec(body: unknown): Parsed<ObjectSpec> {
  const { oid, size } = (body ?? {}) as Record<string, unknown>;
  if (!isValidObject(oid, size)) return { ok: false, status: 422, message: "Invalid oid or size" };
  return { ok: true, value: { oid: oid as string, size: size as number } };
}

export function requiredPermission(operation: Operation): Permission {
  return operation === "upload" ? "write" : "read";
}

export type UploadDecision = { kind: "exists" } | { kind: "too-large"; limitBytes: number } | { kind: "upload" };

export function decideUpload(
  object: ObjectSpec,
  stored: { size: number } | null,
  transfer: { presigned: boolean; proxyMaxUploadBytes: number },
): UploadDecision {
  if (stored && stored.size === object.size) return { kind: "exists" };
  if (!transfer.presigned && object.size > transfer.proxyMaxUploadBytes) {
    return { kind: "too-large", limitBytes: transfer.proxyMaxUploadBytes };
  }
  return { kind: "upload" };
}

export function tooLargeMessage(limitBytes: number): string {
  const limitMb = Math.floor(limitBytes / 1024 / 1024);
  return `Object is larger than ${limitMb} MB, the proxy upload limit. Configure presigned URLs (R2_ACCESS_KEY_ID etc.) to upload it.`;
}
