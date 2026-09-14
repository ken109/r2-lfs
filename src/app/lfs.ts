import { hasPermission, type Permission } from "../domain/access.ts";
import {
  applyQuota,
  decideUpload,
  isValidObject,
  type ObjectSpec,
  parseBatchRequest,
  parseObjectSpec,
  R2_MAX_SINGLE_UPLOAD_BYTES,
  type Rejection,
  requiredPermission,
  tooLargeMessage,
} from "../domain/batch.ts";
import type { Config } from "../domain/config.ts";
import { parseRange } from "../domain/range.ts";
import { objectKey, type Repo } from "../domain/repo.ts";
import { type BatchObjectResult, type BatchResponse, incomingKey, memberKey, MULTIPART_TRANSFER, repoPrefix } from "../shared/contract.ts";
import type { ObjectCopier, ObjectStore, TransferLinks } from "./ports.ts";

export type Result<T> = { ok: true; value: T } | ({ ok: false } & Rejection);

const reject = (status: number, message: string): Result<never> => ({ ok: false, status, message });

export interface LfsContext {
  config: Config;
  repo: Repo;
  permission: Permission;
  store: ObjectStore;
  links: TransferLinks;
  /** Presigned mode only: moves hash-checked uploads into place. */
  copier: ObjectCopier | undefined;
  /** Set when the request carries a transfer action's token, which covers this object alone. */
  onlyOid?: string;
}

const shared = (ctx: LfsContext) => ctx.config.storageLayout === "shared";
const liveKey = (ctx: LfsContext, oid: string) => objectKey(ctx.config.storageLayout, ctx.repo, oid);
const stagingKey = (ctx: LfsContext, oid: string) => incomingKey(ctx.repo.owner, ctx.repo.name, oid);
const markerKey = (ctx: LfsContext, oid: string) => memberKey(ctx.repo.owner, ctx.repo.name, oid);
/** Presigned uploads go to a staging key when the Worker checks their hash. */
const staged = (ctx: LfsContext) => ctx.links.presigned && ctx.config.verifyUploads && ctx.copier !== undefined;

/** In the shared layout, only repositories that uploaded an object may read it. */
async function isMember(ctx: LfsContext, oid: string): Promise<boolean> {
  return !shared(ctx) || (await ctx.store.head(markerKey(ctx, oid))) !== null;
}

function denied(required: Permission): Result<never> {
  return reject(403, `You do not have ${required} access to this repository`);
}

async function planObject(
  ctx: LfsContext,
  operation: "upload" | "download",
  raw: { oid: unknown; size: unknown },
  multipart: boolean,
): Promise<BatchObjectResult> {
  if (!isValidObject(raw.oid, raw.size)) {
    return { oid: String(raw.oid), size: Number(raw.size) || 0, error: { code: 422, message: "Invalid oid or size" } };
  }
  const object = raw as ObjectSpec;
  const key = liveKey(ctx, object.oid);
  const stored = await ctx.store.head(key);

  if (operation === "download") {
    if (!stored || !(await isMember(ctx, object.oid))) return { ...object, error: { code: 404, message: "Object does not exist" } };
    return { oid: object.oid, size: stored.size, authenticated: true, actions: { download: await ctx.links.download(key, object.oid) } };
  }

  const member = stored ? await isMember(ctx, object.oid) : false;
  const transfer = {
    presigned: ctx.links.presigned,
    proxyMaxUploadBytes: ctx.config.proxyMaxUploadBytes,
    multipart,
    ...(ctx.config.maxObjectBytes === undefined ? {} : { maxObjectBytes: ctx.config.maxObjectBytes }),
  };
  const decision = decideUpload(object, stored, transfer, member);
  if (decision.kind === "exists") return object;
  if (decision.kind === "too-large") return { ...object, error: { code: 422, message: tooLargeMessage(decision) } };
  if (decision.kind === "over-limit") {
    return {
      ...object,
      error: { code: 422, message: `Object is larger than ${Math.floor(decision.limitBytes / 1024 ** 2)} MB, this server's limit` },
    };
  }
  // The agent finishes the upload with its own call, which checks the hash, so there is no verify action.
  if (multipart) return { ...object, authenticated: true, actions: { upload: await ctx.links.multipart(object.oid) } };
  return {
    ...object,
    authenticated: true,
    actions: {
      upload: await ctx.links.upload(staged(ctx) ? stagingKey(ctx, object.oid) : key, object.oid),
      verify: await ctx.links.verify(object.oid),
    },
  };
}

export async function batch(ctx: LfsContext, body: unknown): Promise<Result<BatchResponse>> {
  const parsed = parseBatchRequest(body);
  if (!parsed.ok) return parsed;
  const required = requiredPermission(parsed.value.operation);
  if (!hasPermission(ctx.permission, required)) return denied(required);

  // Presigned uploads go straight to R2, which is faster, so multipart only takes over where they cannot go.
  const multipart =
    parsed.value.operation === "upload" &&
    parsed.value.transfers.includes(MULTIPART_TRANSFER) &&
    (!ctx.links.presigned || parsed.value.objects.some((o) => typeof o.size === "number" && o.size > R2_MAX_SINGLE_UPLOAD_BYTES));
  let objects = await Promise.all(parsed.value.objects.map((o) => planObject(ctx, parsed.value.operation, o, multipart)));
  if (parsed.value.operation === "upload" && ctx.config.quotaBytes !== undefined) {
    const used = await ctx.store.usage(repoPrefix(ctx.config.storageLayout, ctx.repo.owner, ctx.repo.name));
    const fits = applyQuota(
      objects.map((o) => ({ size: o.size, upload: o.actions?.upload !== undefined })),
      used,
      ctx.config.quotaBytes,
    );
    objects = objects.map((o, i) =>
      fits[i] ? o : { oid: o.oid, size: o.size, error: { code: 507, message: "The repository is over its storage quota on this server" } },
    );
  }
  return { ok: true, value: { transfer: multipart ? MULTIPART_TRANSFER : "basic", objects, hash_algo: "sha256" } };
}

export async function verify(ctx: LfsContext, body: unknown): Promise<Result<Record<string, never>>> {
  if (!hasPermission(ctx.permission, "write")) return denied("write");
  const parsed = parseObjectSpec(body);
  if (!parsed.ok) return parsed;
  const { oid, size } = parsed.value;
  if (ctx.onlyOid !== undefined && ctx.onlyOid !== oid) return reject(403, "This token was issued for another object");
  const key = liveKey(ctx, oid);

  if (staged(ctx)) {
    const staging = stagingKey(ctx, oid);
    const uploaded = await ctx.store.head(staging);
    if (uploaded) {
      const hash = uploaded.size === size ? await ctx.store.sha256(staging) : undefined;
      if (hash !== oid) {
        await ctx.store.delete(staging);
        return reject(
          422,
          uploaded.size === size
            ? "Uploaded content does not match the oid"
            : `Uploaded object is ${uploaded.size} bytes, expected ${size}`,
        );
      }
      if (!(await ctx.store.head(key))) await ctx.copier!.copy(staging, key);
      await ctx.store.delete(staging);
      if (shared(ctx)) await ctx.store.mark(markerKey(ctx, oid));
      return { ok: true, value: {} };
    }
  }

  const stored = await ctx.store.head(key);
  if (!stored) return reject(404, "Object was not uploaded");
  if (stored.size !== size) return reject(422, `Uploaded object is ${stored.size} bytes, expected ${size}`);
  if (!(await isMember(ctx, oid))) {
    // Without hash checks a presigned upload cannot be told apart from a claim; the README says so.
    if (!ctx.links.presigned || staged(ctx)) return reject(404, "Object was not uploaded by this repository");
    await ctx.store.mark(markerKey(ctx, oid));
  }
  return { ok: true, value: {} };
}

export interface Download {
  body: ReadableStream;
  /** The whole object's size. */
  size: number;
  /** The bytes sent, when the client asked for a range to resume an interrupted download. */
  range?: { offset: number; length: number };
}

export async function download(ctx: LfsContext, oid: string, rangeHeader: string | null = null): Promise<Result<Download>> {
  if (!hasPermission(ctx.permission, "read")) return denied("read");
  const key = liveKey(ctx, oid);
  const stored = (await isMember(ctx, oid)) ? await ctx.store.head(key) : null;
  if (!stored) return reject(404, "Object does not exist");
  const range = parseRange(rangeHeader, stored.size);
  if (range === "unsatisfiable") return reject(416, `Range is outside the object's ${stored.size} bytes`);
  const object = await ctx.store.get(key, range);
  if (!object) return reject(404, "Object does not exist");
  return { ok: true, value: { body: object.body, size: object.size, ...(range ? { range } : {}) } };
}

export async function upload(ctx: LfsContext, oid: string, body: ReadableStream | null, length: number): Promise<Result<null>> {
  if (!hasPermission(ctx.permission, "write")) return denied("write");
  if (!body || !Number.isSafeInteger(length)) return reject(411, "Content-Length is required");
  if (length > ctx.config.proxyMaxUploadBytes) return reject(413, "Object is larger than the proxy upload limit");
  const key = liveKey(ctx, oid);
  // An object that is already stored may be under a bucket lock, so a second upload is only checked, not rewritten.
  const target = (await ctx.store.head(key)) ? stagingKey(ctx, oid) : key;
  const outcome = await ctx.store.put(target, body, oid);
  if (outcome === "checksum-mismatch") return reject(422, "Uploaded content does not match the oid");
  if (target !== key) await ctx.store.delete(target);
  if (shared(ctx)) await ctx.store.mark(markerKey(ctx, oid));
  return { ok: true, value: null };
}
