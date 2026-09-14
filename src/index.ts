import type { Env } from "./env.ts";
import { handle } from "./http/handler.ts";

export { RepoLocks } from "./infra/repo-locks.ts";

export default {
  fetch(request, env) {
    return handle(request, env, { fetch: (input, init) => fetch(input, init) });
  },
} satisfies ExportedHandler<Env>;
