import { hasPermission, type Permission } from "../domain/access.ts";
import {
  decideUpload,
  isValidObject,
  type ObjectSpec,
  parseBatchRequest,
  parseObjectSpec,
  type Rejection,
  requiredPermission,
  tooLargeMessage,
} from "../domain/batch.ts";
import type { Config } from "../domain/config.ts";
import { objectKey, type Repo } from "../domain/repo.ts";
import type { BatchObjectResult, BatchResponse } from "../shared/contract.ts";
import type { ObjectStore, TransferLinks } from "./ports.ts";

export type Result<T> = { ok: true; value: T } | ({ ok: false } & Rejection);

const reject = (status: number, message: string): Result<never> => ({ ok: false, status, message });

export interface LfsContext {
  config: Config;
  repo: Repo;
  permission: Permission;
  store: ObjectStore;
  links: TransferLinks;
}

function denied(required: Permission): Result<never> {
  return reject(403, `You do not have ${required} access to this repository`);
}

async function planObject(
  ctx: LfsContext,
  operation: "upload" | "download",
  raw: { oid: unknown; size: unknown },
): Promise<BatchObjectResult> {
  if (!isValidObject(raw.oid, raw.size)) {
    return { oid: String(raw.oid), size: Number(raw.size) || 0, error: { code: 422, message: "Invalid oid or size" } };
  }
  const object = raw as ObjectSpec;
  const key = objectKey(ctx.config.storageLayout, ctx.repo, object.oid);
  const stored = await ctx.store.head(key);

  if (operation === "download") {
    if (!stored) return { ...object, error: { code: 404, message: "Object does not exist" } };
    return { oid: object.oid, size: stored.size, authenticated: true, actions: { download: await ctx.links.download(key, object.oid) } };
  }

  const decision = decideUpload(object, stored, { presigned: ctx.links.presigned, proxyMaxUploadBytes: ctx.config.proxyMaxUploadBytes });
  if (decision.kind === "exists") return object;
  if (decision.kind === "too-large") return { ...object, error: { code: 422, message: tooLargeMessage(decision) } };
  return {
    ...object,
    authenticated: true,
    actions: { upload: await ctx.links.upload(key, object.oid), verify: ctx.links.verify() },
  };
}

export async function batch(ctx: LfsContext, body: unknown): Promise<Result<BatchResponse>> {
  const parsed = parseBatchRequest(body);
  if (!parsed.ok) return parsed;
  const required = requiredPermission(parsed.value.operation);
  if (!hasPermission(ctx.permission, required)) return denied(required);

  const objects = await Promise.all(parsed.value.objects.map((o) => planObject(ctx, parsed.value.operation, o)));
  return { ok: true, value: { transfer: "basic", objects, hash_algo: "sha256" } };
}

export async function verify(ctx: LfsContext, body: unknown): Promise<Result<Record<string, never>>> {
  if (!hasPermission(ctx.permission, "write")) return denied("write");
  const parsed = parseObjectSpec(body);
  if (!parsed.ok) return parsed;
  const stored = await ctx.store.head(objectKey(ctx.config.storageLayout, ctx.repo, parsed.value.oid));
  if (!stored) return reject(404, "Object was not uploaded");
  if (stored.size !== parsed.value.size) return reject(422, `Uploaded object is ${stored.size} bytes, expected ${parsed.value.size}`);
  return { ok: true, value: {} };
}

export async function download(ctx: LfsContext, oid: string): Promise<Result<{ body: ReadableStream; size: number }>> {
  if (!hasPermission(ctx.permission, "read")) return denied("read");
  const object = await ctx.store.get(objectKey(ctx.config.storageLayout, ctx.repo, oid));
  if (!object) return reject(404, "Object does not exist");
  return { ok: true, value: object };
}

export async function upload(ctx: LfsContext, oid: string, body: ReadableStream | null, length: number): Promise<Result<null>> {
  if (!hasPermission(ctx.permission, "write")) return denied("write");
  if (!body || !Number.isSafeInteger(length)) return reject(411, "Content-Length is required");
  if (length > ctx.config.proxyMaxUploadBytes) return reject(413, "Object is larger than the proxy upload limit");
  const outcome = await ctx.store.put(objectKey(ctx.config.storageLayout, ctx.repo, oid), body, oid);
  if (outcome === "checksum-mismatch") return reject(422, "Uploaded content does not match the oid");
  return { ok: true, value: null };
}
