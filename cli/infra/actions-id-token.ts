import type { ActionsIdTokens } from "../app/ports.ts";

/** Requests OIDC tokens the way actions/core does, from the variables a job with `id-token: write` gets. */
export class GithubActionsIdTokens implements ActionsIdTokens {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  available(): boolean {
    return Boolean(this.env.ACTIONS_ID_TOKEN_REQUEST_URL && this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  }

  async request(audience: string): Promise<string | undefined> {
    if (!this.available()) return undefined;
    const url = new URL(this.env.ACTIONS_ID_TOKEN_REQUEST_URL!);
    url.searchParams.set("audience", audience);
    const res = await fetch(url, { headers: { Authorization: `bearer ${this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
    if (!res.ok) return undefined;
    const value = ((await res.json()) as { value?: unknown }).value;
    return typeof value === "string" ? value : undefined;
  }
}
