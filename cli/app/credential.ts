import { type AgentTarget, CREDENTIAL_LAUNCHER, credentialHelperCommand, credentialLauncherScript } from "../domain/launchers.ts";
import { type LfsLocation, parseLfsUrl } from "../domain/remote.ts";
import type { ActionsIdTokens, LfsClient, SessionCache } from "./ports.ts";
import type { LauncherDeps } from "./transfer-agent.ts";

export interface CredentialDeps {
  /** R2_LFS_TOKEN, which takes precedence. */
  token: string | undefined;
  actions: ActionsIdTokens;
  connect: (location: LfsLocation, token: string | undefined) => LfsClient;
  /** The GitHub CLI's token, when it is logged in. */
  ghToken: () => string | undefined;
  sessions: SessionCache;
  now: () => Date;
}

/** A cached token is used while it has this long left, so it does not expire in the middle of a command. */
const REUSE_MARGIN_MS = 10 * 60_000;

/** The repository a credential request is for; git sends the path only with credential.useHttpPath. */
function requestLocation(origin: string, path: string | undefined): LfsLocation | undefined {
  return path ? parseLfsUrl(`${origin}/${path.replace(/^\/+/, "")}`) : undefined;
}

/**
 * The password to send to an r2-lfs server: R2_LFS_TOKEN; inside GitHub Actions an OIDC token for the audience the
 * server announces; otherwise the gh login, traded with the server for a short-lived token for the repository when git
 * says which repository. Undefined lets git try its other helpers or ask.
 */
export async function passwordFor(deps: CredentialDeps, origin: string, path?: string): Promise<string | undefined> {
  if (deps.token) return deps.token;
  if (deps.actions.available()) {
    const url = new URL(origin);
    const client = deps.connect({ url: url.origin, origin: url.origin, host: url.host, owner: "", repo: "" }, undefined);
    const info = await client.info().catch(() => undefined);
    if (info?.kind !== "ok" || !info.info.actionsOidcAudience) return undefined;
    return deps.actions.request(info.info.actionsOidcAudience);
  }

  const ghToken = deps.ghToken();
  if (!ghToken) return undefined;
  const location = requestLocation(origin, path);
  // Without a repository there is nothing to trade for; the server accepts the gh token itself.
  if (!location) return ghToken;
  const cached = deps.sessions.get(location);
  if (cached && cached.expiresAt.getTime() - deps.now().getTime() > REUSE_MARGIN_MS) return cached.token;
  const session = await deps
    .connect(location, ghToken)
    .session()
    .catch(() => undefined);
  // Servers before sessions, or a repository the account cannot see: the gh token gets the server's own answer.
  if (!session) return ghToken;
  deps.sessions.set(location, session);
  return session.token;
}

/** git calls `erase` after the server rejected a password, so the next `get` trades for a new token. */
export function forgetSession(sessions: SessionCache, origin: string, path: string | undefined): void {
  const location = requestLocation(origin, path);
  if (location) sessions.delete(location);
}

/**
 * Makes git ask r2-lfs for `origin`'s credentials through a launcher, and send the repository's path with each request so
 * the helper can trade for a token scoped to it. Returns the launcher's path.
 */
export function installCredentialHelper(deps: LauncherDeps, target: AgentTarget, origin: string): string {
  deps.files.mkdirp(deps.configDir);
  const launcher = deps.join(deps.configDir, CREDENTIAL_LAUNCHER);
  deps.files.writeExecutable(launcher, credentialLauncherScript(target));
  deps.gitConfig.useCredentialHelper(origin, credentialHelperCommand(launcher));
  deps.gitConfig.set(`credential.${origin}.useHttpPath`, "true");
  return launcher;
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
