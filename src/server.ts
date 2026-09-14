import startHandler from "@tanstack/react-start/server-entry";

import type { Env } from "./env.ts";
import { gateAdmin } from "./http/admin-gate.ts";
import worker from "./index.ts";
import { ADMIN_PATH } from "./shared/contract.ts";

export { RepoLocks } from "./infra/repo-locks.ts";

const isAdmin = (pathname: string) => pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`);

/** The deployed Worker: the admin UI under /_admin, behind Cloudflare Access, and the Git LFS API for everything else. */
export default {
  async fetch(request, env) {
    if (!isAdmin(new URL(request.url).pathname)) return worker.fetch(request, env);
    const denied = await gateAdmin(request, env, { fetch: (input, init) => fetch(input, init) });
    return denied ?? startHandler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
