/** Git LFS sends HTTP Basic credentials from the credential helper; the password is the token. */
export function extractToken(header: string | null): string | undefined {
  if (!header) return undefined;
  const [scheme, credentials] = header.split(" ", 2);
  if (!credentials) return undefined;
  if (scheme?.toLowerCase() === "bearer") return credentials;
  if (scheme?.toLowerCase() !== "basic") return undefined;
  let decoded: string;
  try {
    decoded = atob(credentials);
  } catch {
    return undefined;
  }
  const sep = decoded.indexOf(":");
  const password = sep === -1 ? decoded : decoded.slice(sep + 1);
  return password || undefined;
}
