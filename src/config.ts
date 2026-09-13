export interface Env {
  BUCKET: R2Bucket;
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
export type StorageLayout = "per-repo" | "shared";
export type Permission = "none" | "read" | "write";

export interface TokenGrant {
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
  tokens: readonly TokenGrant[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`r2-lfs is misconfigured:\n- ${problems.join("\n- ")}`);
  }
}

/** Deploy forms may leave optional values blank; treat blank as unset. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function oneOf<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  problems: string[],
): T {
  const v = value(raw);
  if (v === undefined) return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  problems.push(`${name} must be one of ${allowed.join(", ")} (got "${v}")`);
  return fallback;
}

export function parseTokens(raw: string | undefined, problems: string[]): TokenGrant[] {
  const grants: TokenGrant[] = [];
  for (const entry of (raw ?? "").split(/[,\n]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [scope, perm, ...rest] = trimmed.split(":");
    const token = rest.join(":");
    const validScope = scope !== undefined && /^(\*|[\w.-]+\/(\*|[\w.-]+))$/.test(scope);
    if (!validScope || (perm !== "r" && perm !== "rw") || token.length < 16) {
      // Never echo the entry: it contains the token.
      problems.push(
        `AUTH_TOKENS entry #${grants.length + 1} must look like <owner/repo|owner/*|*>:<r|rw>:<token of 16+ chars>`,
      );
      continue;
    }
    grants.push({ scope: scope.toLowerCase(), permission: perm === "rw" ? "write" : "read", token });
  }
  return grants;
}

export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const ownersRaw = value(env.ALLOWED_OWNERS);
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
  }

  const authMode = oneOf("AUTH_MODE", env.AUTH_MODE, ["github", "token"], "github", problems);
  const storageLayout = oneOf(
    "STORAGE_LAYOUT",
    env.STORAGE_LAYOUT,
    ["per-repo", "shared"],
    "per-repo",
    problems,
  );
  const transferMode = oneOf(
    "TRANSFER_MODE",
    env.TRANSFER_MODE,
    ["auto", "presigned", "proxy"],
    "auto",
    problems,
  );

  const maxMb = Number(value(env.PROXY_MAX_UPLOAD_MB) ?? "100");
  if (!Number.isFinite(maxMb) || maxMb <= 0) {
    problems.push("PROXY_MAX_UPLOAD_MB must be a positive number");
  }

  const creds = {
    accountId: value(env.R2_ACCOUNT_ID),
    bucketName: value(env.R2_BUCKET_NAME),
    accessKeyId: value(env.R2_ACCESS_KEY_ID),
    secretAccessKey: value(env.R2_SECRET_ACCESS_KEY),
  };
  const missing = Object.entries({
    R2_ACCOUNT_ID: creds.accountId,
    R2_BUCKET_NAME: creds.bucketName,
    R2_ACCESS_KEY_ID: creds.accessKeyId,
    R2_SECRET_ACCESS_KEY: creds.secretAccessKey,
  })
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  const presignReady = missing.length === 0;
  if (transferMode === "presigned" && !presignReady) {
    problems.push(`TRANSFER_MODE=presigned needs ${missing.join(", ")}`);
  }
  const presign =
    transferMode !== "proxy" && presignReady ? (creds as PresignCredentials) : undefined;

  const tokens = parseTokens(env.AUTH_TOKENS, problems);
  if (authMode === "token" && tokens.length === 0 && !problems.some((p) => p.startsWith("AUTH_TOKENS"))) {
    problems.push("AUTH_MODE=token needs at least one entry in AUTH_TOKENS");
  }

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
