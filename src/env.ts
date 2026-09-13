import type { ConfigVars } from "./domain/config.ts";

export interface Env extends ConfigVars {
  BUCKET: R2Bucket;
}
