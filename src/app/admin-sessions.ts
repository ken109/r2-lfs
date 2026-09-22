import type { Result } from "./lfs.ts";
import type { SessionKeyRotator } from "./ports.ts";

/** Revokes every short-lived token the Worker issued, within the minutes other isolates keep the old key. */
export async function rotateSessionKey(deps: { keys: SessionKeyRotator; now: () => Date }): Promise<Result<{ rotatedAt: string }>> {
  try {
    await deps.keys.rotate();
  } catch (err) {
    return { ok: false, status: 502, message: `Could not delete the session key: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, value: { rotatedAt: deps.now().toISOString() } };
}
