import { SCOPE_PATTERN, type StorageLayout } from "../shared/contract.ts";

/** The Worker variables and secrets that configure r2-lfs. All optional here; validation decides. */
export interface ConfigVars {
  ALLOWED_OWNERS?: string;
  AUTH_MODE?: string;
  STORAGE_LAYOUT?: string;
  TRANSFER_MODE?: string;
  PROXY_MAX_UPLOAD_MB?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  AUTH_TOKENS?: string;
}

export type AuthMode = "github" | "token";

export interface StaticToken {
  /** `owner/repo`, `owner/*` or `*`, lowercased. */
  scope: string;
  permission: "read" | "write";
  token: string;
}

export interface PresignCredentials {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface Config {
  /** Lowercased owners, or `*` for anyone. */
  allowedOwners: ReadonlySet<string> | "*";
  authMode: AuthMode;
  storageLayout: StorageLayout;
  /** Set when transfers go through presigned URLs; absent means proxy. */
  presign: PresignCredentials | undefined;
  proxyMaxUploadBytes: number;
  tokens: readonly StaticToken[];
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

export function parseStaticTokens(raw: string | undefined, problems: string[]): StaticToken[] {
  const tokens: StaticToken[] = [];
  let index = 0;
  for (const entry of (raw ?? "").split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    index++;
    const [scope, perm, ...rest] = trimmed.split(":");
    const token = rest.join(":");
    const validScope = scope !== undefined && SCOPE_PATTERN.test(scope);
    if (!validScope || (perm !== "r" && perm !== "rw") || token.length < 16) {
      // Never echo the entry: it contains the token.
      problems.push(`AUTH_TOKENS entry #${index} must look like <owner/repo|owner/*|*>:<r|rw>:<token of 16+ chars>`);
      continue;
    }
    tokens.push({ scope: scope.toLowerCase(), permission: perm === "rw" ? "write" : "read", token });
  }
  return tokens;
}

export function parseConfig(vars: ConfigVars): Config {
  const problems: string[] = [];

  const ownersRaw = value(vars.ALLOWED_OWNERS);
  let allowedOwners: Config["allowedOwners"] = new Set();
  if (ownersRaw === undefined) {
    problems.push("ALLOWED_OWNERS is required, e.g. `my-name,my-org`");
  } else if (ownersRaw === "*") {
    allowedOwners = "*";
  } else {
    allowedOwners = new Set(
      ownersRaw
        .split(",")
        .map((o) => o.trim().toLowerCase())
        .filter(Boolean),
    );
    if (allowedOwners.size === 0) problems.push("ALLOWED_OWNERS lists no owner, e.g. `my-name,my-org`");
  }

  const authMode = oneOf("AUTH_MODE", vars.AUTH_MODE, ["github", "token"], "github", problems);
  const storageLayout = oneOf("STORAGE_LAYOUT", vars.STORAGE_LAYOUT, ["per-repo", "shared"], "per-repo", problems);
  const transferMode = oneOf("TRANSFER_MODE", vars.TRANSFER_MODE, ["auto", "presigned", "proxy"], "auto", problems);

  const maxMb = Number(value(vars.PROXY_MAX_UPLOAD_MB) ?? "100");
  if (!Number.isFinite(maxMb) || maxMb <= 0) problems.push("PROXY_MAX_UPLOAD_MB must be a positive number");

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

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    allowedOwners,
    authMode,
    storageLayout,
    presign,
    proxyMaxUploadBytes: Math.floor(maxMb * 1024 * 1024),
    tokens,
  };
}
