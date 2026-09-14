import { authorizeAdmin } from "../app/admin.ts";
import { type Config, ConfigError, parseConfig } from "../domain/config.ts";
import type { Env } from "../env.ts";
import { AccessJwtVerifier } from "../infra/access-verifier.ts";
import type { Fetcher } from "../infra/host-permissions.ts";

export type AdminGate = { ok: true; config: Config; email: string } | { ok: false; response: Response };

const text = (status: number, message: string): AdminGate => ({
  ok: false,
  response: new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } }),
});

/**
 * Lets admin requests through only when Cloudflare Access did, and changes only from the admin UI's own pages:
 * the Access cookie would otherwise ride along on a form another site posts here.
 */
export async function gateAdmin(request: Request, env: Env, deps: { fetch: Fetcher }): Promise<AdminGate> {
  let config;
  try {
    config = parseConfig(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return text(500, err.message);
  }
  const result = await authorizeAdmin(config, request.headers.get("Cf-Access-Jwt-Assertion") ?? undefined, {
    access: new AccessJwtVerifier(deps.fetch),
  });
  if (!result.ok) return text(result.status, result.message);
  if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("Origin") !== new URL(request.url).origin) {
    return text(403, "Changes are accepted only from the admin UI's own pages");
  }
  return { ok: true, config, email: result.email };
}
