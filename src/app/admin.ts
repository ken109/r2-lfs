import type { Config } from "../domain/config.ts";
import type { AccessVerifier } from "./ports.ts";

export type AdminResult = { ok: true; email: string } | { ok: false; status: 403 | 404; message: string };

/** Who may open the admin UI: whoever Cloudflare Access let through, and nobody when Access is not configured. */
export async function authorizeAdmin(
  config: Config,
  assertion: string | undefined,
  deps: { access: AccessVerifier },
): Promise<AdminResult> {
  if (!config.access) {
    return {
      ok: false,
      status: 404,
      message: "The admin UI is off. Put it behind Cloudflare Access and set ACCESS_TEAM_DOMAIN and ACCESS_AUD.",
    };
  }
  if (!assertion) return { ok: false, status: 403, message: "Sign in through Cloudflare Access" };
  const email = await deps.access.verify(assertion, config.access);
  if (!email) return { ok: false, status: 403, message: "The Cloudflare Access token is not valid for this application" };
  return { ok: true, email };
}
