import type { RepoLocks } from "../../src/infra/repo-locks.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      BUCKET: R2Bucket;
      LOCKS: DurableObjectNamespace<RepoLocks>;
    }
  }
}
