import { authorize } from "../app/authorize.ts";
import * as lfs from "../app/lfs.ts";
import { createLock, listLocks, type LockResponse, type LocksContext, unlock, verifyLocks } from "../app/locks.ts";
import * as multipart from "../app/multipart.ts";
import { changeObjects, listObjects } from "../app/repository-storage.ts";
import { actionAuthorization, checkTransferScope, openSession, type TransferScope } from "../app/session.ts";
import { loadConfig, publicSettings } from "../domain/config.ts";
import type { Repo } from "../domain/repo.ts";
import type { Env } from "../env.ts";
import { GithubActionsOidc } from "../infra/actions-oidc.ts";
import { AnalyticsEngineMetrics } from "../infra/analytics-metrics.ts";
import { type Fetcher, RemoteHostPermissions } from "../infra/host-permissions.ts";
import { looksLikeJwt } from "../infra/jwt.ts";
import { R2MultipartStore } from "../infra/r2-multipart-store.ts";
import { R2ObjectStore } from "../infra/r2-object-store.ts";
import { R2RepositoryIdentities } from "../infra/r2-repository-identities.ts";
import { R2RepositoryStorage } from "../infra/r2-repository-storage.ts";
import { DurableObjectLockStore } from "../infra/repo-locks.ts";
import { S3Copier } from "../infra/s3-copier.ts";
import { HmacSessionTokens } from "../infra/session-tokens.ts";
import { CombinedTokenDirectory } from "../infra/token-directory.ts";
import { PresignedLinks, ProxyLinks } from "../infra/transfer-links.ts";
import { type MisconfiguredInfo, VERSION } from "../shared/contract.ts";
import { extractCredentials } from "./credentials.ts";
import { lfsError, lfsJson } from "./responses.ts";
import { allowsMethod, type Route, route } from "./router.ts";

export interface Deps {
  fetch: Fetcher;
}

const LANDING = `r2-lfs is running.

Point a repository at it with a .lfsconfig like:

[lfs]
  url = https://<this host>/<owner>/<repo>
  locksverify = true

https://github.com/ken109/r2-lfs
`;

const lockResponse = ({ status, body }: LockResponse) => lfsJson(status, body);

function toResponse<T>(result: lfs.Result<T>, onOk: (value: T) => Response): Response {
  return result.ok ? onOk(result.value) : lfsError(result.status, result.message);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Non-secret settings, so `r2-lfs doctor` can explain what the server expects. */
function info(env: Env): Response {
  const loaded = loadConfig(env);
  if (loaded.ok) return Response.json(publicSettings(loaded.value));
  const body: MisconfiguredInfo = { name: "r2-lfs", version: VERSION, problems: loaded.error.problems };
  return Response.json(body, { status: 500 });
}

/** Bodies up to this size are read to the end when a request is answered without them. */
const DRAIN_LIMIT_BYTES = 1024 * 1024;

/**
 * Reads what is left of a small request body that the answer did not need, such as git-lfs's lock check that
 * is refused with 401 before the Worker looks at it. Unread bytes left on a kept-alive connection broke the
 * next request on it under wrangler dev ("Network connection lost").
 */
async function drainUnread(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  const length = Number(request.headers.get("Content-Length"));
  if (!Number.isFinite(length) || length > DRAIN_LIMIT_BYTES) return;
  await request.arrayBuffer().catch(() => undefined);
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const matched = route(url.pathname);
  if (matched.kind !== "landing" && matched.kind !== "info" && matched.kind !== "not-found") {
    const response = await handleRepository(request, env, deps, url, matched);
    await drainUnread(request);
    // Bytes that crossed the Worker: proxied downloads and uploads.
    const length =
      matched.kind === "object" || matched.kind === "multipart"
        ? (request.method === "PUT" ? request.headers : response.headers).get("Content-Length")
        : null;
    new AnalyticsEngineMetrics(env.METRICS).record({
      repo: `${matched.owner}/${matched.name}`.toLowerCase(),
      endpoint: matched.kind,
      method: request.method,
      status: response.status,
      bytes: Number(length) || 0,
    });
    return response;
  }

  if (matched.kind === "not-found") return lfsError(404, "Not found");
  if (!allowsMethod(matched, request.method)) return lfsError(405, "Method not allowed");
  return matched.kind === "info" ? info(env) : new Response(LANDING, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

type RepositoryRoute = Exclude<Route, { kind: "landing" | "info" | "not-found" }>;

function transferScope(matched: RepositoryRoute): TransferScope {
  if (matched.kind === "verify") return { kind: "verify" };
  if (matched.kind === "object" || matched.kind === "multipart") return { kind: "transfer", oid: matched.oid };
  return { kind: "other" };
}

async function handleRepository(request: Request, env: Env, deps: Deps, url: URL, matched: RepositoryRoute): Promise<Response> {
  const repo: Repo = { owner: matched.owner, name: matched.name };

  const loaded = loadConfig(env);
  if (!loaded.ok) {
    console.error(loaded.error.message);
    return lfsError(500, loaded.error.message);
  }
  const config = loaded.value;

  const credentials = extractCredentials(request.headers.get("Authorization"));
  const sessions = new HmacSessionTokens(env.BUCKET);
  const auth = await authorize(config, repo, credentials, {
    tokens: new CombinedTokenDirectory(config.tokens, env.BUCKET),
    host: new RemoteHostPermissions(deps.fetch, config.host),
    actions: new GithubActionsOidc(deps.fetch),
    identities: new R2RepositoryIdentities(env.BUCKET),
    sessions,
    isJwt: looksLikeJwt,
  });
  if (!auth.ok) return lfsError(auth.status, auth.message);
  const scoped = checkTransferScope(auth.oid, transferScope(matched));
  if (!scoped.ok) return lfsError(scoped.status, scoped.message);
  if (!allowsMethod(matched, request.method)) return lfsError(405, "Method not allowed");

  const baseUrl = `${url.origin}/${repo.owner}/${repo.name}`;
  const authorizeAction = actionAuthorization({ repo, sessions });
  const ctx: lfs.LfsContext = {
    config,
    repo,
    permission: auth.permission,
    store: new R2ObjectStore(env.BUCKET, config.encryptionKey),
    links: config.presign ? new PresignedLinks(config.presign, baseUrl, authorizeAction) : new ProxyLinks(baseUrl, authorizeAction),
    copier: config.presign ? new S3Copier(config.presign, deps.fetch) : undefined,
    ...(auth.oid === undefined ? {} : { onlyOid: auth.oid }),
  };

  const parts: multipart.MultipartContext = { ...ctx, multipart: new R2MultipartStore(env.BUCKET, config.encryptionKey) };

  const locks: LocksContext = {
    permission: auth.permission,
    identify: auth.identify,
    locks: new DurableObjectLockStore(env.LOCKS, repo),
  };

  switch (matched.kind) {
    case "storage": {
      const storage = { config, repo, permission: auth.permission, storage: new R2RepositoryStorage(env.BUCKET, config.encryptionKey) };
      if (matched.action === undefined) {
        const listed = await listObjects(storage, url.searchParams.get("in"), url.searchParams.get("cursor"));
        return toResponse(listed, (body) => lfsJson(200, body));
      }
      return toResponse(await changeObjects(storage, matched.action, await readJson(request)), (body) => lfsJson(200, body));
    }
    case "session": {
      const session = { repo, permission: auth.permission, identify: auth.identify, sessions };
      return toResponse(await openSession(session, credentials), (body) => lfsJson(200, body));
    }
    case "locks":
      if (request.method === "GET") return lockResponse(await listLocks(locks, url.searchParams));
      return lockResponse(await createLock(locks, await readJson(request)));
    case "locks-verify":
      return lockResponse(await verifyLocks(locks, await readJson(request)));
    case "unlock":
      return lockResponse(await unlock(locks, matched.id, await readJson(request)));
    case "batch":
      return toResponse(await lfs.batch(ctx, await readJson(request)), (body) => lfsJson(200, body));
    case "verify":
      return toResponse(await lfs.verify(ctx, await readJson(request)), (body) => lfsJson(200, body));
    case "object": {
      if (request.method === "GET") {
        return toResponse(await lfs.download(ctx, matched.oid, request.headers.get("Range")), ({ body, size, range }) =>
          range
            ? new Response(body, {
                status: 206,
                headers: {
                  "Content-Type": "application/octet-stream",
                  "Content-Length": String(range.length),
                  "Content-Range": `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`,
                  "Accept-Ranges": "bytes",
                },
              })
            : new Response(body, {
                headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size), "Accept-Ranges": "bytes" },
              }),
        );
      }
      // Number(null) would be 0 and pass the size checks, leaving R2 to fail on a stream of unknown length.
      const header = request.headers.get("Content-Length")?.trim();
      const length = header ? Number(header) : Number.NaN;
      return toResponse(await lfs.upload(ctx, matched.oid, request.body, length), () => new Response(null, { status: 200 }));
    }
    case "multipart": {
      const { oid, uploadId, part, complete } = matched;
      if (uploadId === undefined) {
        return toResponse(await multipart.startMultipart(parts, oid, await readJson(request)), (body) => lfsJson(200, body));
      }
      if (complete) {
        return toResponse(await multipart.completeMultipart(parts, oid, uploadId, await readJson(request)), (body) => lfsJson(200, body));
      }
      if (part !== undefined) {
        const header = request.headers.get("Content-Length")?.trim();
        const length = header ? Number(header) : Number.NaN;
        return toResponse(await multipart.uploadPart(parts, oid, uploadId, part, request.body, length), (body) => lfsJson(200, body));
      }
      return toResponse(await multipart.abortMultipart(parts, oid, uploadId), (body) => lfsJson(200, body));
    }
  }
}
