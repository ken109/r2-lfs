import { type AuthMode, REPO_PATTERN, type StorageLayout } from "../shared/contract.ts";

/** The Worker variables and secrets that configure r2-lfs. All optional here; validation decides. */
export interface ConfigVars {
  ALLOWED_REPOS?: string;
  /** Deprecated: owners, each read as `<owner>/*` in ALLOWED_REPOS. */
  ALLOWED_OWNERS?: string;
  AUTH_MODE?: string;
  /** The host of a self-managed GitHub Enterprise Server, GitLab, Gitea or Forgejo. */
  AUTH_HOST?: string;
  STORAGE_LAYOUT?: string;
  TRANSFER_MODE?: string;
  PROXY_MAX_UPLOAD_MB?: string;
  /** Largest object accepted, in MB; empty for no limit. */
  MAX_OBJECT_MB?: string;
  /** Storage per repository (or for the whole shared pool), in GB; empty for no limit. */
  QUOTA_GB?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  AUTH_TOKENS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACTIONS_OIDC?: string;
  VERIFY_UPLOADS?: string;
  ACTIONS_OIDC_AUDIENCE?: string;
}

export interface StaticToken {
  /** A REPO_PATTERN, lowercased. */
  scope: string;
  permission: "read" | "write" | "admin";
  token: string;
  /** How file locks name the holder: `AUTH_TOKENS #<n>`. */
  holder: string;
}

export interface PresignCredentials {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The Cloudflare Access application in front of the admin UI. */
export interface AccessSettings {
  /** Such as `my-team.cloudflareaccess.com`. */
  teamDomain: string;
  /** The application's audience tag. */
  aud: string;
}

/** GitHub Actions workflows authenticating with their OIDC token, for their own repository only. */
export interface ActionsOidcSettings {
  permission: "read" | "write";
  /** The `aud` workflows request the token for. */
  audience: string;
}

/** Which Git host's permissions to mirror, by its web origin, such as https://gitlab.example.com. */
export interface HostSettings {
  kind: Exclude<AuthMode, "token">;
  url: string;
}

export interface Config {
  /** Lowercased REPO_PATTERNs of the repositories this server serves. */
  allowedRepos: readonly string[];
  authMode: AuthMode;
  /** The Git host to ask; unused in token mode. */
  host: HostSettings;
  storageLayout: StorageLayout;
  /** Set when transfers go through presigned URLs; absent means proxy. */
  presign: PresignCredentials | undefined;
  /** Hash presigned uploads before they count as stored. Proxy uploads are always checked by R2. */
  verifyUploads: boolean;
  proxyMaxUploadBytes: number;
  maxObjectBytes: number | undefined;
  quotaBytes: number | undefined;
  tokens: readonly StaticToken[];
  /** Settings that work but should change, such as deprecated variables. */
  warnings: readonly string[];
  /** Unset keeps the admin UI closed. */
  access: AccessSettings | undefined;
  actionsOidc: ActionsOidcSettings | undefined;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`r2-lfs is misconfigured:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

/** Deploy forms may leave optional values blank; treat blank as unset. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function oneOf<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T, problems: string[]): T {
  const v = value(raw);
  if (v === undefined) return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  problems.push(`${name} must be one of ${allowed.join(", ")} (got "${v}")`);
  return fallback;
}

/** Entries of a comma- or newline-separated list, trimmed. */
function listOf(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseStaticTokens(raw: string | undefined, problems: string[]): StaticToken[] {
  const tokens: StaticToken[] = [];
  let index = 0;
  for (const entry of (raw ?? "").split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    index++;
    const [scope, perm, ...rest] = trimmed.split(":");
    const token = rest.join(":");
    const validScope = scope !== undefined && REPO_PATTERN.test(scope);
    if (!validScope || (perm !== "r" && perm !== "rw" && perm !== "admin") || token.length < 16) {
      // Never echo the entry: it contains the token.
      problems.push(`AUTH_TOKENS entry #${index} must look like <owner/repo, * allowed within names>:<r|rw|admin>:<token of 16+ chars>`);
      continue;
    }
    const permission = perm === "admin" ? "admin" : perm === "rw" ? "write" : "read";
    tokens.push({ scope: scope.toLowerCase(), permission, token, holder: `AUTH_TOKENS #${index}` });
  }
  return tokens;
}

export function parseConfig(vars: ConfigVars): Config {
  const problems: string[] = [];

  const warnings: string[] = [];
  const reposRaw = value(vars.ALLOWED_REPOS);
  const ownersRaw = value(vars.ALLOWED_OWNERS);
  const allowedRepos = [
    ...listOf(reposRaw),
    // Before ALLOWED_REPOS, the server was limited by owner: `acme` meant every repository of acme.
    ...listOf(ownersRaw).map((owner) => (owner === "*" ? "*" : `${owner}/*`)),
  ].map((pattern) => pattern.toLowerCase());
  if (ownersRaw !== undefined) {
    warnings.push("ALLOWED_OWNERS is deprecated; list repositories in ALLOWED_REPOS instead, such as `my-org/*` for an owner");
  }
  if (reposRaw === undefined && ownersRaw === undefined) {
    problems.push("ALLOWED_REPOS is required, e.g. `my-name/*,my-org/assets`");
  } else if (allowedRepos.length === 0) {
    problems.push("ALLOWED_REPOS lists no repository, e.g. `my-name/*,my-org/assets`");
  }
  for (const pattern of allowedRepos) {
    if (!REPO_PATTERN.test(pattern))
      problems.push(`ALLOWED_REPOS entry "${pattern}" must be owner/repo, with * allowed within names, or *`);
  }

  const authMode = oneOf("AUTH_MODE", vars.AUTH_MODE, ["github", "gitlab", "gitea", "bitbucket", "token"], "github", problems);
  const hostRaw = value(vars.AUTH_HOST);
  let hostUrl = { github: "https://github.com", gitlab: "https://gitlab.com", gitea: "", bitbucket: "https://bitbucket.org", token: "" }[
    authMode
  ];
  if (hostRaw !== undefined) {
    try {
      const parsed = new URL(/^https?:\/\//.test(hostRaw) ? hostRaw : `https://${hostRaw}`);
      if (authMode === "bitbucket") problems.push("AUTH_HOST is not used with AUTH_MODE=bitbucket, which is Bitbucket Cloud only");
      hostUrl = parsed.origin;
    } catch {
      problems.push("AUTH_HOST must be a URL such as https://gitlab.example.com");
    }
  }
  if (authMode === "gitea" && !hostUrl) problems.push("AUTH_MODE=gitea needs AUTH_HOST, the address of your Gitea or Forgejo");
  const storageLayout = oneOf("STORAGE_LAYOUT", vars.STORAGE_LAYOUT, ["per-repo", "shared"], "per-repo", problems);
  const transferMode = oneOf("TRANSFER_MODE", vars.TRANSFER_MODE, ["auto", "presigned", "proxy"], "auto", problems);

  const maxMb = Number(value(vars.PROXY_MAX_UPLOAD_MB) ?? "100");
  if (!Number.isFinite(maxMb) || maxMb <= 0) problems.push("PROXY_MAX_UPLOAD_MB must be a positive number");

  const limit = (name: string, raw: string | undefined, unit: number) => {
    const text = value(raw);
    if (text === undefined) return undefined;
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) problems.push(`${name} must be a positive number`);
    return Math.floor(n * unit);
  };
  const maxObjectBytes = limit("MAX_OBJECT_MB", vars.MAX_OBJECT_MB, 1024 ** 2);
  const quotaBytes = limit("QUOTA_GB", vars.QUOTA_GB, 1024 ** 3);

  const creds = {
    R2_ACCOUNT_ID: value(vars.R2_ACCOUNT_ID),
    R2_BUCKET_NAME: value(vars.R2_BUCKET_NAME),
    R2_ACCESS_KEY_ID: value(vars.R2_ACCESS_KEY_ID),
    R2_SECRET_ACCESS_KEY: value(vars.R2_SECRET_ACCESS_KEY),
  };
  const missing = Object.entries(creds)
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  if (transferMode === "presigned" && missing.length > 0) {
    problems.push(`TRANSFER_MODE=presigned needs ${missing.join(", ")}`);
  }
  const presign: PresignCredentials | undefined =
    transferMode !== "proxy" && missing.length === 0
      ? {
          accountId: creds.R2_ACCOUNT_ID!,
          bucketName: creds.R2_BUCKET_NAME!,
          accessKeyId: creds.R2_ACCESS_KEY_ID!,
          secretAccessKey: creds.R2_SECRET_ACCESS_KEY!,
        }
      : undefined;

  // In token mode AUTH_TOKENS may be empty: tokens can also live in the bucket (`r2-lfs token`).
  const tokens = parseStaticTokens(vars.AUTH_TOKENS, problems);

  const verifyUploads = oneOf("VERIFY_UPLOADS", vars.VERIFY_UPLOADS, ["on", "off"], "on", problems) === "on";
  const actionsMode = oneOf("ACTIONS_OIDC", vars.ACTIONS_OIDC, ["off", "read", "write"], "off", problems);
  const actionsAudience = value(vars.ACTIONS_OIDC_AUDIENCE) ?? "r2-lfs";

  const teamDomain = value(vars.ACCESS_TEAM_DOMAIN)
    ?.replace(/^https:\/\//, "")
    .replace(/\/+$/, "");
  const aud = value(vars.ACCESS_AUD);
  if ((teamDomain === undefined) !== (aud === undefined)) problems.push("ACCESS_TEAM_DOMAIN and ACCESS_AUD are needed together");
  if (teamDomain !== undefined && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(teamDomain)) {
    problems.push("ACCESS_TEAM_DOMAIN must be a host name such as my-team.cloudflareaccess.com");
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    allowedRepos,
    authMode,
    host: { kind: authMode === "token" ? "github" : authMode, url: hostUrl || "https://github.com" },
    storageLayout,
    presign,
    verifyUploads,
    proxyMaxUploadBytes: Math.floor(maxMb * 1024 * 1024),
    maxObjectBytes,
    quotaBytes,
    tokens,
    warnings,
    access: teamDomain && aud ? { teamDomain: teamDomain.toLowerCase(), aud } : undefined,
    actionsOidc: actionsMode === "off" ? undefined : { permission: actionsMode, audience: actionsAudience },
  };
}
