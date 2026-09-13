import { authorize } from "../app/authorize.ts";
import * as lfs from "../app/lfs.ts";
import { ownerAllowed } from "../domain/access.ts";
import { type Config, ConfigError, parseConfig } from "../domain/config.ts";
import { isSafeRepoName, type Repo } from "../domain/repo.ts";
import type { Env } from "../env.ts";
import { type Fetcher, GithubApiPermissions } from "../infra/github-permissions.ts";
import { R2ObjectStore } from "../infra/r2-object-store.ts";
import { CombinedTokenDirectory } from "../infra/token-directory.ts";
import { PresignedLinks, ProxyLinks } from "../infra/transfer-links.ts";
import { type ServerInfo, VERSION } from "../shared/contract.ts";
import { extractToken } from "./credentials.ts";
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
      storageLayout: config.storageLayout,
      transfer: config.presign ? "presigned" : "proxy",
      proxyMaxUploadBytes: config.proxyMaxUploadBytes,
    };
    return Response.json(body);
  } catch (err) {
    if (err instanceof ConfigError) return Response.json({ name: "r2-lfs", version: VERSION, problems: err.problems }, { status: 500 });
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
    case "locks":
      // File locking is not implemented; 404 tells git-lfs to skip it.
      return lfsError(404, "Locking is not supported");
    case "not-found":
      return lfsError(404, "Not found");
  }

  const repo: Repo = { owner: matched.owner, name: matched.name };
  if (!isSafeRepoName(repo.name)) return lfsError(404, "Not found");

  let config: Config;
  try {
    config = parseConfig(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    return lfsError(500, err.message);
  }

  if (!ownerAllowed(config, repo.owner)) return lfsError(403, `${repo.owner} is not allowed on this server`);

  const authorization = request.headers.get("Authorization") ?? "";
  const auth = await authorize(config, repo, extractToken(authorization), {
    tokens: new CombinedTokenDirectory(config.tokens, env.BUCKET),
    github: new GithubApiPermissions(deps.fetch),
  });
  if (!auth.ok) return lfsError(auth.status, auth.message);

  const baseUrl = `${url.origin}/${repo.owner}/${repo.name}`;
  const ctx: lfs.LfsContext = {
    config,
    repo,
    permission: auth.permission,
    store: new R2ObjectStore(env.BUCKET),
    links: config.presign ? new PresignedLinks(config.presign, baseUrl, authorization) : new ProxyLinks(baseUrl, authorization),
  };

  switch (matched.kind) {
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
