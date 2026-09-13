import { INFO_PATH } from "../shared/contract.ts";

export type Route =
  | { kind: "landing" }
  | { kind: "info" }
  | { kind: "batch"; owner: string; name: string }
  | { kind: "verify"; owner: string; name: string }
  | { kind: "object"; owner: string; name: string; oid: string }
  | { kind: "locks" }
  | { kind: "not-found" };

// `/<owner>/<repo>[.git][/info/lfs]/<endpoint>`; the optional parts let either URL style work.
const LFS_ROUTE =
  /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/info\/lfs)?\/(objects\/batch|objects\/verify|objects\/([0-9a-f]{64})|locks(?:\/.*)?)$/;

export function route(pathname: string): Route {
  if (pathname === "/") return { kind: "landing" };
  if (pathname === INFO_PATH) return { kind: "info" };
  const match = LFS_ROUTE.exec(pathname);
  if (!match) return { kind: "not-found" };
  const [, owner, name, endpoint, oid] = match as unknown as [string, string, string, string, string | undefined];
  if (endpoint.startsWith("locks")) return { kind: "locks" };
  if (endpoint === "objects/batch") return { kind: "batch", owner, name };
  if (endpoint === "objects/verify") return { kind: "verify", owner, name };
  return { kind: "object", owner, name, oid: oid! };
}
