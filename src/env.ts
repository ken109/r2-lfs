import type { ConfigVars } from "./domain/config.ts";
import type { RepoLocks } from "./infra/repo-locks.ts";

export interface Env extends ConfigVars {
  BUCKET: R2Bucket;
  LOCKS: DurableObjectNamespace<RepoLocks>;
}
