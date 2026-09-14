import { authorize } from "../app/authorize.ts";
import * as lfs from "../app/lfs.ts";
import { createLock, listLocks, type LockResponse, type LocksContext, unlock, verifyLocks } from "../app/locks.ts";
import { type Config, ConfigError, parseConfig } from "../domain/config.ts";
import type { Repo } from "../domain/repo.ts";
import type { Env } from "../env.ts";
import { GithubActionsOidc } from "../infra/actions-oidc.ts";
import { type Fetcher, RemoteHostPermissions } from "../infra/host-permissions.ts";
import { looksLikeJwt } from "../infra/jwt.ts";
import { R2ObjectStore } from "../infra/r2-object-store.ts";
import { DurableObjectLockStore } from "../infra/repo-locks.ts";
import { S3Copier } from "../infra/s3-copier.ts";
import { CombinedTokenDirectory } from "../infra/token-directory.ts";
import { PresignedLinks, ProxyLinks } from "../infra/transfer-links.ts";
import { type MisconfiguredInfo, type ServerInfo, VERSION } from "../shared/contract.ts";
import { extractCredentials } from "./credentials.ts";
import { lfsError, lfsJson } from "./responses.ts";
import { route } from "./router.ts";

export interface Deps {
  fetch: Fetcher;
}

const LANDING = `r2-lfs is running.

Point a repository at it with a .lfsconfig like:

[lfs]
  url = https://<this host>/<owner>/<repo>
  locksverify = false

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
  try {
    const config = parseConfig(env);
    const body: ServerInfo = {
      name: "r2-lfs",
      version: VERSION,
      authMode: config.authMode,
      ...(config.authMode === "token" ? {} : { authHost: config.host.url }),
      storageLayout: config.storageLayout,
      transfer: config.presign ? "presigned" : "proxy",
      proxyMaxUploadBytes: config.proxyMaxUploadBytes,
      ...(config.warnings.length > 0 ? { warnings: [...config.warnings] } : {}),
      ...(config.actionsOidc ? { actionsOidcAudience: config.actionsOidc.audience } : {}),
    };
    return Response.json(body);
  } catch (err) {
    if (err instanceof ConfigError) {
      const body: MisconfiguredInfo = { name: "r2-lfs", version: VERSION, problems: err.problems };
      return Response.json(body, { status: 500 });
    }
    throw err;
  }
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const matched = route(url.pathname);

  switch (matched.kind) {
    case "landing":
      return request.method === "GET"
        ? new Response(LANDING, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
        : lfsError(405, "Method not allowed");
    case "info":
      return request.method === "GET" ? info(env) : lfsError(405, "Method not allowed");
    case "not-found":
      return lfsError(404, "Not found");
  }

  const repo: Repo = { owner: matched.owner, name: matched.name };

  let config: Config;
  try {
    config = parseConfig(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    return lfsError(500, err.message);
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const auth = await authorize(config, repo, extractCredentials(authorization), {
    tokens: new CombinedTokenDirectory(config.tokens, env.BUCKET),
    host: new RemoteHostPermissions(deps.fetch, config.host),
    actions: new GithubActionsOidc(deps.fetch),
    isJwt: looksLikeJwt,
  });
  if (!auth.ok) return lfsError(auth.status, auth.message);

  const baseUrl = `${url.origin}/${repo.owner}/${repo.name}`;
  const ctx: lfs.LfsContext = {
    config,
    repo,
    permission: auth.permission,
    store: new R2ObjectStore(env.BUCKET),
    links: config.presign ? new PresignedLinks(config.presign, baseUrl, authorization) : new ProxyLinks(baseUrl, authorization),
    copier: config.presign ? new S3Copier(config.presign, deps.fetch) : undefined,
  };

  const locks: LocksContext = {
    permission: auth.permission,
    identify: auth.identify,
    locks: new DurableObjectLockStore(env.LOCKS, repo),
  };

  switch (matched.kind) {
    case "locks":
      if (request.method === "GET") return lockResponse(await listLocks(locks, url.searchParams));
      if (request.method === "POST") return lockResponse(await createLock(locks, await readJson(request)));
      return lfsError(405, "Method not allowed");
    case "locks-verify":
      if (request.method !== "POST") return lfsError(405, "Method not allowed");
      return lockResponse(await verifyLocks(locks, await readJson(request)));
    case "unlock":
      if (request.method !== "POST") return lfsError(405, "Method not allowed");
      return lockResponse(await unlock(locks, matched.id, await readJson(request)));
    case "batch":
      if (request.method !== "POST") return lfsError(405, "Method not allowed");
      return toResponse(await lfs.batch(ctx, await readJson(request)), (body) => lfsJson(200, body));
    case "verify":
      if (request.method !== "POST") return lfsError(405, "Method not allowed");
      return toResponse(await lfs.verify(ctx, await readJson(request)), (body) => lfsJson(200, body));
    case "object":
      if (request.method === "GET") {
        return toResponse(
          await lfs.download(ctx, matched.oid),
          ({ body, size }) =>
            new Response(body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) } }),
        );
      }
      if (request.method === "PUT") {
        // Number(null) would be 0 and pass the size checks, leaving R2 to fail on a stream of unknown length.
        const header = request.headers.get("Content-Length")?.trim();
        const length = header ? Number(header) : Number.NaN;
        return toResponse(await lfs.upload(ctx, matched.oid, request.body, length), () => new Response(null, { status: 200 }));
      }
      return lfsError(405, "Method not allowed");
  }
}
