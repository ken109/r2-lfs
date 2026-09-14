import { INFO_PATH, OWNER_NAME, REPO_NAME } from "../shared/contract.ts";

export type Route =
  | { kind: "landing" }
  | { kind: "info" }
  | { kind: "batch"; owner: string; name: string }
  | { kind: "verify"; owner: string; name: string }
  | { kind: "object"; owner: string; name: string; oid: string }
  | { kind: "multipart"; owner: string; name: string; oid: string; uploadId?: string; part?: number; complete?: boolean }
  | { kind: "locks"; owner: string; name: string }
  | { kind: "locks-verify"; owner: string; name: string }
  | { kind: "unlock"; owner: string; name: string; id: string }
  | { kind: "not-found" };

// `/<owner>/<repo>[.git][/info/lfs]/<endpoint>`; the optional parts let either URL style work.
const LFS_ROUTE = new RegExp(
  `^/(${OWNER_NAME})/(${REPO_NAME}?)(?:\\.git)?(?:/info/lfs)?/(objects/batch|objects/verify|objects/([0-9a-f]{64})(?:/multipart(?:/([A-Za-z0-9._~%-]{1,1024})(?:/(\\d{1,5}|complete))?)?)?|locks|locks/verify|locks/([A-Za-z0-9-]{1,64})/unlock)$`,
);

export function route(pathname: string): Route {
  if (pathname === "/") return { kind: "landing" };
  if (pathname === INFO_PATH) return { kind: "info" };
  const match = LFS_ROUTE.exec(pathname);
  if (!match) return { kind: "not-found" };
  const [, owner, name, endpoint, oid, uploadId, part, lockId] = match as unknown as [
    string,
    string,
    string,
    string,
    string | undefined,
    string | undefined,
    string | undefined,
    string | undefined,
  ];
  if (endpoint === "locks") return { kind: "locks", owner, name };
  if (endpoint === "locks/verify") return { kind: "locks-verify", owner, name };
  if (lockId !== undefined) return { kind: "unlock", owner, name, id: lockId };
  if (endpoint === "objects/batch") return { kind: "batch", owner, name };
  if (endpoint === "objects/verify") return { kind: "verify", owner, name };
  if (endpoint.endsWith("/multipart") || endpoint.includes("/multipart/")) {
    let id: string | undefined;
    try {
      id = uploadId === undefined ? undefined : decodeURIComponent(uploadId);
    } catch {
      return { kind: "not-found" };
    }
    return {
      kind: "multipart",
      owner,
      name,
      oid: oid!,
      ...(id === undefined ? {} : { uploadId: id }),
      ...(part === undefined ? {} : part === "complete" ? { complete: true } : { part: Number(part) }),
    };
  }
  return { kind: "object", owner, name, oid: oid! };
}
