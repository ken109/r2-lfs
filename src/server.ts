import startHandler from "@tanstack/react-start/server-entry";

import type { Env } from "./env.ts";
import worker from "./index.ts";
import { ADMIN_PATH } from "./shared/contract.ts";

const isAdmin = (pathname: string) => pathname === ADMIN_PATH || pathname.startsWith(`${ADMIN_PATH}/`);

/** The deployed Worker: the admin UI under /_admin, and the Git LFS API for everything else. */
export default {
  fetch(request, env) {
    if (isAdmin(new URL(request.url).pathname)) return startHandler.fetch(request);
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
