import type { Credentials } from "../app/ports.ts";

/** Git LFS sends HTTP Basic credentials from the credential helper; the password is the token. */
export function extractCredentials(header: string | null): Credentials | undefined {
  if (!header) return undefined;
  const [scheme, encoded] = header.split(" ", 2);
  if (!encoded) return undefined;
  if (scheme?.toLowerCase() === "bearer") return { password: encoded };
  if (scheme?.toLowerCase() !== "basic") return undefined;
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    return undefined;
  }
  const sep = decoded.indexOf(":");
  const password = sep === -1 ? decoded : decoded.slice(sep + 1);
  const username = sep === -1 ? "" : decoded.slice(0, sep);
  if (!password) return undefined;
  return username ? { username, password } : { password };
}
