import { authorize, type Fetcher, ownerAllowed, type Repo } from "./auth.ts";
import { ConfigError, type Env, loadConfig } from "./config.ts";
import { handleBatch, handleDownload, handleUpload, handleVerify, lfsError, type RequestContext } from "./lfs.ts";

export interface Deps {
  fetch: Fetcher;
}

// `/<owner>/<repo>[.git][/info/lfs]/<endpoint>`; the optional parts let either URL style work.
const ROUTE = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/info\/lfs)?\/(objects\/batch|objects\/verify|objects\/[0-9a-f]{64}|locks(?:\/.*)?)$/;

const UNAUTHORIZED_HEADERS = { "LFS-Authenticate": 'Basic realm="r2-lfs"' };

const LANDING = `r2-lfs is running.

Point a repository at it with a .lfsconfig like:

[lfs]
  url = https://<this host>/<owner>/<repo>
  locksverify = false

https://github.com/ken109/r2-lfs
`;

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/" && request.method === "GET") {
    return new Response(LANDING, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const match = ROUTE.exec(url.pathname);
  if (!match) return lfsError(404, "Not found");
  const [, owner, name, endpoint] = match as unknown as [string, string, string, string];
  // Dot segments would be collapsed in presigned URLs and escape the repository's prefix.
  if (/^\.+$/.test(name)) return lfsError(404, "Not found");

  // File locking is not implemented; 404 tells git-lfs to skip it.
  if (endpoint.startsWith("locks")) return lfsError(404, "Locking is not supported");

  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return lfsError(500, err.message);
    }
    throw err;
  }

  const repo: Repo = { owner, name };
  if (!ownerAllowed(config, owner)) {
    return lfsError(403, `${owner} is not allowed on this server`);
  }

  const auth = await authorize(config, request, repo, deps.fetch);
  if (!auth.ok) {
    return lfsError(auth.status, auth.message, auth.status === 401 ? UNAUTHORIZED_HEADERS : {});
  }

  const ctx: RequestContext = {
    config,
    bucket: env.BUCKET,
    repo,
    permission: auth.permission,
    baseUrl: `${url.origin}/${owner}/${name}`,
    authorization: request.headers.get("Authorization") ?? "",
  };

  if (endpoint === "objects/batch" || endpoint === "objects/verify") {
    if (request.method !== "POST") return lfsError(405, "Method not allowed");
    return endpoint === "objects/batch" ? handleBatch(ctx, request) : handleVerify(ctx, request);
  }

  const oid = endpoint.slice("objects/".length);
  if (request.method === "GET") return handleDownload(ctx, oid);
  if (request.method === "PUT") return handleUpload(ctx, oid, request);
  return lfsError(405, "Method not allowed");
}

export default {
  fetch(request, env) {
    return handle(request, env, { fetch: (input, init) => fetch(input, init) });
  },
} satisfies ExportedHandler<Env>;
