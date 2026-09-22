import { INFO_PATH, LFS_OID, OWNER_NAME, REPO_NAME, SESSION_ENDPOINT, STORAGE_ENDPOINT, type StorageAction } from "../shared/contract.ts";

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
  | { kind: "session"; owner: string; name: string }
  | { kind: "storage"; owner: string; name: string; action?: StorageAction }
  | { kind: "not-found" };

// `/<owner>/<repo>[.git][/info/lfs]/<endpoint>`; the optional parts let either URL style work.
const LFS_ROUTE = new RegExp(
  `^/(${OWNER_NAME})/(${REPO_NAME}?)(?:\\.git)?(?:/info/lfs)?/(objects/batch|objects/verify|objects/(${LFS_OID})(?:/multipart(?:/([A-Za-z0-9._~%-]{1,1024})(?:/(\\d{1,5}|complete))?)?)?|locks|locks/verify|locks/([A-Za-z0-9-]{1,64})/unlock|${SESSION_ENDPOINT}|${STORAGE_ENDPOINT}(?:/(?:trash|restore|tier))?)$`,
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
  if (endpoint === SESSION_ENDPOINT) return { kind: "session", owner, name };
  if (endpoint === STORAGE_ENDPOINT) return { kind: "storage", owner, name };
  if (endpoint.startsWith(`${STORAGE_ENDPOINT}/`)) {
    return { kind: "storage", owner, name, action: endpoint.slice(STORAGE_ENDPOINT.length + 1) as StorageAction };
  }
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

/** Routes, with multipart uploads and storage split into the requests they take. */
type Endpoint =
  | Exclude<Route["kind"], "multipart" | "storage" | "not-found">
  | "multipart-start"
  | "multipart-part"
  | "multipart-complete"
  | "multipart-abort"
  | "storage-list"
  | "storage-change";

/** The methods each endpoint answers; any other gets 405. */
const METHODS: Record<Endpoint, readonly string[]> = {
  landing: ["GET"],
  info: ["GET"],
  batch: ["POST"],
  verify: ["POST"],
  object: ["GET", "PUT"],
  "multipart-start": ["POST"],
  "multipart-part": ["PUT"],
  "multipart-complete": ["POST"],
  "multipart-abort": ["DELETE"],
  locks: ["GET", "POST"],
  "locks-verify": ["POST"],
  unlock: ["POST"],
  session: ["POST"],
  "storage-list": ["GET"],
  "storage-change": ["POST"],
};

function endpointOf(matched: Exclude<Route, { kind: "not-found" }>): Endpoint {
  if (matched.kind === "storage") return matched.action === undefined ? "storage-list" : "storage-change";
  if (matched.kind !== "multipart") return matched.kind;
  if (matched.uploadId === undefined) return "multipart-start";
  if (matched.complete) return "multipart-complete";
  return matched.part === undefined ? "multipart-abort" : "multipart-part";
}

export function allowsMethod(matched: Exclude<Route, { kind: "not-found" }>, method: string): boolean {
  return METHODS[endpointOf(matched)].includes(method);
}
