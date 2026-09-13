import type { Repo } from "./auth.ts";
import type { Config, Permission } from "./config.ts";
import { OID_PATTERN, objectKey, PRESIGN_EXPIRES_SECONDS, presignUrl } from "./storage.ts";

export const LFS_CONTENT_TYPE = "application/vnd.git-lfs+json";
const MAX_OBJECTS_PER_BATCH = 1000;

export function lfsJson(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": LFS_CONTENT_TYPE, ...headers },
  });
}

export function lfsError(status: number, message: string, headers: HeadersInit = {}): Response {
  return lfsJson(status, { message }, headers);
}

interface Action {
  href: string;
  header?: Record<string, string>;
  expires_in?: number;
}

interface ObjectResponse {
  oid: string;
  size: number;
  authenticated?: boolean;
  actions?: Record<string, Action>;
  error?: { code: number; message: string };
}

export interface RequestContext {
  config: Config;
  bucket: R2Bucket;
  repo: Repo;
  permission: Permission;
  /** `https://host/owner/repo`, the base that git-lfs was pointed at. */
  baseUrl: string;
  /** Forwarded to proxy transfer actions so they authenticate the same way as the batch call. */
  authorization: string;
}

function isValidSize(size: unknown): size is number {
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0;
}

async function transferAction(
  ctx: RequestContext,
  oid: string,
  method: "GET" | "PUT",
): Promise<Action> {
  const key = objectKey(ctx.config, ctx.repo, oid);
  if (ctx.config.presign) {
    return {
      href: await presignUrl(ctx.config.presign, key, method),
      expires_in: PRESIGN_EXPIRES_SECONDS,
    };
  }
  return {
    href: `${ctx.baseUrl}/objects/${oid}`,
    header: { Authorization: ctx.authorization },
  };
}

async function planObject(
  ctx: RequestContext,
  operation: "upload" | "download",
  oid: unknown,
  size: unknown,
): Promise<ObjectResponse> {
  if (typeof oid !== "string" || !OID_PATTERN.test(oid) || !isValidSize(size)) {
    return {
      oid: String(oid),
      size: Number(size) || 0,
      error: { code: 422, message: "Invalid oid or size" },
    };
  }

  const stored = await ctx.bucket.head(objectKey(ctx.config, ctx.repo, oid));

  if (operation === "download") {
    if (!stored) return { oid, size, error: { code: 404, message: "Object does not exist" } };
    return { oid, size: stored.size, authenticated: true, actions: { download: await transferAction(ctx, oid, "GET") } };
  }

  if (stored && stored.size === size) return { oid, size };

  if (!ctx.config.presign && size > ctx.config.proxyMaxUploadBytes) {
    const limitMb = Math.floor(ctx.config.proxyMaxUploadBytes / 1024 / 1024);
    return {
      oid,
      size,
      error: {
        code: 422,
        message: `Object is larger than ${limitMb} MB, the proxy upload limit. Configure presigned URLs (R2_ACCESS_KEY_ID etc.) to upload it.`,
      },
    };
  }

  return {
    oid,
    size,
    authenticated: true,
    actions: {
      upload: await transferAction(ctx, oid, "PUT"),
      verify: { href: `${ctx.baseUrl}/objects/verify`, header: { Authorization: ctx.authorization } },
    },
  };
}

export async function handleBatch(ctx: RequestContext, request: Request): Promise<Response> {
  let body: { operation?: unknown; objects?: unknown; hash_algo?: unknown };
  try {
    body = await request.json();
  } catch {
    return lfsError(400, "Request body is not valid JSON");
  }

  const { operation, objects } = body;
  if (operation !== "upload" && operation !== "download") {
    return lfsError(422, "operation must be upload or download");
  }
  if (body.hash_algo !== undefined && body.hash_algo !== "sha256") {
    return lfsError(409, "Only sha256 is supported");
  }
  if (!Array.isArray(objects) || objects.length > MAX_OBJECTS_PER_BATCH) {
    return lfsError(422, `objects must be an array of at most ${MAX_OBJECTS_PER_BATCH} entries`);
  }

  const required: Permission = operation === "upload" ? "write" : "read";
  if (!hasPermission(ctx.permission, required)) {
    return lfsError(403, `You do not have ${required} access to this repository`);
  }

  const planned = await Promise.all(
    objects.map((o: { oid?: unknown; size?: unknown } | null) => planObject(ctx, operation, o?.oid, o?.size)),
  );
  return lfsJson(200, { transfer: "basic", objects: planned, hash_algo: "sha256" });
}

export async function handleVerify(ctx: RequestContext, request: Request): Promise<Response> {
  if (!hasPermission(ctx.permission, "write")) {
    return lfsError(403, "You do not have write access to this repository");
  }
  let body: { oid?: unknown; size?: unknown };
  try {
    body = await request.json();
  } catch {
    return lfsError(400, "Request body is not valid JSON");
  }
  if (typeof body.oid !== "string" || !OID_PATTERN.test(body.oid) || !isValidSize(body.size)) {
    return lfsError(422, "Invalid oid or size");
  }
  const stored = await ctx.bucket.head(objectKey(ctx.config, ctx.repo, body.oid));
  if (!stored) return lfsError(404, "Object was not uploaded");
  if (stored.size !== body.size) {
    return lfsError(422, `Uploaded object is ${stored.size} bytes, expected ${body.size}`);
  }
  return lfsJson(200, {});
}

export async function handleDownload(ctx: RequestContext, oid: string): Promise<Response> {
  if (!hasPermission(ctx.permission, "read")) {
    return lfsError(403, "You do not have read access to this repository");
  }
  const object = await ctx.bucket.get(objectKey(ctx.config, ctx.repo, oid));
  if (!object) return lfsError(404, "Object does not exist");
  return new Response(object.body, {
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(object.size) },
  });
}

export async function handleUpload(ctx: RequestContext, oid: string, request: Request): Promise<Response> {
  if (!hasPermission(ctx.permission, "write")) {
    return lfsError(403, "You do not have write access to this repository");
  }
  const length = Number(request.headers.get("Content-Length"));
  if (!request.body || !Number.isSafeInteger(length)) {
    return lfsError(411, "Content-Length is required");
  }
  if (length > ctx.config.proxyMaxUploadBytes) {
    return lfsError(413, "Object is larger than the proxy upload limit");
  }
  try {
    // R2 rejects the write if the body does not hash to the oid, so a proxied object is always intact.
    await ctx.bucket.put(objectKey(ctx.config, ctx.repo, oid), request.body, { sha256: oid });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/sha-?256|digest|checksum/i.test(message)) {
      return lfsError(422, "Uploaded content does not match the oid");
    }
    throw err;
  }
  return new Response(null, { status: 200 });
}

export function hasPermission(actual: Permission, required: Permission): boolean {
  const rank: Record<Permission, number> = { none: 0, read: 1, write: 2 };
  return rank[actual] >= rank[required];
}
