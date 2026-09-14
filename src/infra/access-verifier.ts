import type { AccessVerifier } from "../app/ports.ts";
import type { AccessSettings } from "../domain/config.ts";
import type { Fetcher } from "./github-permissions.ts";
import { verifyJwt } from "./jwt.ts";

/** Verifies the tokens Cloudflare Access issues, against the team's published signing keys. */
export class AccessJwtVerifier implements AccessVerifier {
  private readonly fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    this.fetcher = fetcher;
  }

  async verify(token: string, settings: AccessSettings): Promise<string | undefined> {
    const claims = await verifyJwt(this.fetcher, token, {
      jwksUrl: `https://${settings.teamDomain}/cdn-cgi/access/certs`,
      issuer: `https://${settings.teamDomain}`,
      audience: settings.aud,
    });
    if (!claims) return undefined;
    return typeof claims.email === "string" ? claims.email : typeof claims.sub === "string" ? claims.sub : undefined;
  }
}
