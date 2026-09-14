import type { LfsLocation } from "../domain/remote.ts";
import type { ActionsIdTokens, LfsClient } from "./ports.ts";

export interface CredentialDeps {
  /** R2_LFS_TOKEN, which takes precedence. */
  token: string | undefined;
  actions: ActionsIdTokens;
  connect: (location: LfsLocation, token: string | undefined) => LfsClient;
}

/**
 * The password to send to an r2-lfs server: R2_LFS_TOKEN, or inside GitHub Actions an OIDC token for the
 * audience the server announces. Undefined lets git try its other helpers or ask.
 */
export async function passwordFor(deps: CredentialDeps, origin: string): Promise<string | undefined> {
  if (deps.token) return deps.token;
  if (!deps.actions.available()) return undefined;
  const url = new URL(origin);
  const client = deps.connect({ url: url.origin, origin: url.origin, host: url.host, owner: "", repo: "" }, undefined);
  const info = await client.info().catch(() => undefined);
  if (info?.kind !== "ok" || !info.info.actionsOidcAudience) return undefined;
  return deps.actions.request(info.info.actionsOidcAudience);
}

/** The fields of a git credential request, such as protocol and host. */
export function parseCredentialRequest(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return fields;
}
