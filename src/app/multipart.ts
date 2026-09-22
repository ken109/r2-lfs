import { hasPermission } from "../domain/access.ts";
import { objectKey } from "../domain/repo.ts";
import { MultipartCompleteRequest, MultipartStartRequest, Oid, read, UploadedParts } from "../domain/requests.ts";
import { incomingKey, memberKey, MIN_PART_BYTES, type MultipartStart } from "../shared/contract.ts";
import type { LfsContext, Result } from "./lfs.ts";
import type { MultipartStore } from "./ports.ts";

export interface MultipartContext extends LfsContext {
  multipart: MultipartStore;
}

/** R2 allows at most 10,000 parts. */
const MAX_PARTS = 10_000;

const reject = (status: number, message: string): Result<never> => ({ ok: false, status, message });
const staging = (ctx: LfsContext, oid: string) => incomingKey(ctx.repo.owner, ctx.repo.name, oid);

/** The most one part may hold: one request to the Worker, but never below R2's minimum part. */
const maxPartBytes = (ctx: LfsContext) => Math.max(MIN_PART_BYTES, ctx.config.proxyMaxUploadBytes);

/** Parts as large as a request may be, if 10,000 of them can hold `size`. */
export function partSizeFor(size: number, proxyMaxUploadBytes: number): number | undefined {
  const partSize = Math.max(MIN_PART_BYTES, proxyMaxUploadBytes);
  return size <= partSize * MAX_PARTS ? partSize : undefined;
}

/** POST /objects/<oid>/multipart {size} */
export async function startMultipart(ctx: MultipartContext, oid: string, body: unknown): Promise<Result<MultipartStart>> {
  if (!hasPermission(ctx.permission, "write")) return reject(403, "You do not have write access to this repository");
  const request = read(MultipartStartRequest, body);
  if (read(Oid, oid) === undefined || !request) return reject(422, "Invalid oid or size");
  const { size } = request;
  if (ctx.config.maxObjectBytes !== undefined && size > ctx.config.maxObjectBytes) {
    return reject(422, `Object is larger than ${Math.floor(ctx.config.maxObjectBytes / 1024 ** 2)} MB, this server's limit`);
  }
  const partSize = partSizeFor(size, ctx.config.proxyMaxUploadBytes);
  if (partSize === undefined) return reject(422, "Object needs more than 10,000 parts of this server's request size");
  return { ok: true, value: { uploadId: await ctx.multipart.create(staging(ctx, oid)), partSize } };
}

/** PUT /objects/<oid>/multipart/<uploadId>/<part> */
export async function uploadPart(
  ctx: MultipartContext,
  oid: string,
  uploadId: string,
  partNumber: number,
  body: ReadableStream | null,
  length: number,
): Promise<Result<{ partNumber: number; etag: string }>> {
  if (!hasPermission(ctx.permission, "write")) return reject(403, "You do not have write access to this repository");
  if (!body || !Number.isSafeInteger(length)) return reject(411, "Content-Length is required");
  if (length > maxPartBytes(ctx)) return reject(413, "Part is larger than the proxy upload limit");
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) return reject(422, "Part number must be 1 to 10000");
  const part = await ctx.multipart.uploadPart(staging(ctx, oid), uploadId, partNumber, body);
  return part ? { ok: true, value: part } : reject(404, "No such upload; start a new one");
}

/**
 * POST /objects/<oid>/multipart/<uploadId>/complete {size, parts}. Finishes the upload, checks that it hashes
 * to the oid, and moves it into place, so a finished call leaves the object stored or nothing at all.
 */
export async function completeMultipart(
  ctx: MultipartContext,
  oid: string,
  uploadId: string,
  body: unknown,
): Promise<Result<Record<string, never>>> {
  if (!hasPermission(ctx.permission, "write")) return reject(403, "You do not have write access to this repository");
  const request = read(MultipartCompleteRequest, body);
  if (read(Oid, oid) === undefined || !request) return reject(422, "size and parts are required");
  const { size } = request;
  const parts = read(UploadedParts, request.parts);
  if (!parts) return reject(422, "Each part needs partNumber and etag");

  const key = staging(ctx, oid);
  const live = objectKey(ctx.config.storageLayout, ctx.repo, oid);
  const marker = memberKey(ctx.repo.owner, ctx.repo.name, oid);
  try {
    await ctx.multipart.complete(key, uploadId, parts);
  } catch (err) {
    // A client retrying after losing the answer finds the upload already completed: carry on from what it left.
    if ((await ctx.store.head(key))?.size !== size) {
      const stored = await ctx.store.head(live);
      const member = ctx.config.storageLayout !== "shared" || (await ctx.store.head(marker)) !== null;
      if (stored?.size === size && member) return { ok: true, value: {} };
      return reject(422, `Could not complete the upload: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const uploaded = await ctx.store.head(key);
  let outcome: "stored" | "checksum-mismatch";
  if (!uploaded || uploaded.size !== size) outcome = "checksum-mismatch";
  else if (await ctx.store.head(live)) outcome = (await ctx.store.sha256(key)) === oid ? "stored" : "checksum-mismatch";
  else outcome = await ctx.multipart.promote(key, live, oid, size);
  await ctx.store.delete(key);

  if (outcome === "checksum-mismatch") return reject(422, "Uploaded content does not match the oid and size");
  if (ctx.config.storageLayout === "shared") await ctx.store.mark(marker);
  return { ok: true, value: {} };
}

/** DELETE /objects/<oid>/multipart/<uploadId> */
export async function abortMultipart(ctx: MultipartContext, oid: string, uploadId: string): Promise<Result<Record<string, never>>> {
  if (!hasPermission(ctx.permission, "write")) return reject(403, "You do not have write access to this repository");
  await ctx.multipart.abort(staging(ctx, oid), uploadId).catch(() => {});
  return { ok: true, value: {} };
}
