import { authorizeAdmin } from "../app/admin.ts";
import { ConfigError, parseConfig } from "../domain/config.ts";
import type { Env } from "../env.ts";
import { AccessJwtVerifier } from "../infra/access-verifier.ts";
import type { Fetcher } from "../infra/host-permissions.ts";

/** Stops admin requests that Cloudflare Access did not let through; undefined lets the request go on to the UI. */
export async function gateAdmin(request: Request, env: Env, deps: { fetch: Fetcher }): Promise<Response | undefined> {
  let config;
  try {
    config = parseConfig(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return new Response(err.message, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const result = await authorizeAdmin(config, request.headers.get("Cf-Access-Jwt-Assertion") ?? undefined, {
    access: new AccessJwtVerifier(deps.fetch),
  });
  if (result.ok) return undefined;
  return new Response(result.message, { status: result.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
