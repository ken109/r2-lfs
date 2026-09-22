import type { SessionKeyRotator } from "../app/ports.ts";
import { SESSION_KEY_KEY } from "../shared/contract.ts";
import { clearSessionKeyCache } from "./session-tokens.ts";

/**
 * Deletes the key the Worker signs short-lived tokens with. The next token minted creates a new one, and isolates
 * that cached the old key stop accepting its tokens once their cache expires.
 */
export class R2SessionKey implements SessionKeyRotator {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async rotate() {
    await this.bucket.delete(SESSION_KEY_KEY);
    clearSessionKeyCache();
  }
}
