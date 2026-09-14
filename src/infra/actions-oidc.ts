import type { ActionsClaims, ActionsTokenVerifier } from "../app/ports.ts";
import type { Fetcher } from "./github-permissions.ts";
import { verifyJwt } from "./jwt.ts";

export const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

/** Verifies the OpenID Connect tokens GitHub Actions gives workflows with `id-token: write`. */
export class GithubActionsOidc implements ActionsTokenVerifier {
  private readonly fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    this.fetcher = fetcher;
  }

  async verify(token: string, audience: string): Promise<ActionsClaims | undefined> {
    const claims = await verifyJwt(this.fetcher, token, {
      jwksUrl: `${ACTIONS_ISSUER}/.well-known/jwks`,
      issuer: ACTIONS_ISSUER,
      audience,
    });
    if (typeof claims?.repository !== "string") return undefined;
    return {
      repository: claims.repository,
      actor: typeof claims.actor === "string" ? claims.actor : "unknown",
      workflow: typeof claims.workflow === "string" ? claims.workflow : undefined,
    };
  }
}
