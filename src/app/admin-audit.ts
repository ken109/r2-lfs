import type { Result } from "./lfs.ts";
import type { AuditEntry, AuditLog } from "./ports.ts";

export interface AuditDeps {
  log: AuditLog;
  email: string;
  /** Undefined lets the change happen; a reason refuses it, as when ADMIN_EMAILS leaves this person out. */
  refusal: string | undefined;
  now: () => Date;
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs a change of the admin UI, unless the person may only look, and records who asked for what, when and how it
 * ended. A change that happened is not undone because the record could not be written; that is reported instead.
 */
export async function audited<T>(
  deps: AuditDeps,
  change: { action: string; target: string; detail?: (value: T) => string | undefined },
  run: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const entry = (outcome: AuditEntry["outcome"], detail: string | undefined): AuditEntry => ({
    at: deps.now().toISOString(),
    email: deps.email,
    action: change.action,
    target: change.target,
    outcome,
    ...(detail ? { detail } : {}),
  });
  const record = async (e: AuditEntry) => {
    try {
      await deps.log.record(e);
    } catch (err) {
      console.error("Could not write the audit log:", describe(err), e);
    }
  };

  if (deps.refusal !== undefined) {
    await record(entry("refused", deps.refusal));
    return { ok: false, status: 403, message: deps.refusal };
  }
  let result: Result<T>;
  try {
    result = await run();
  } catch (err) {
    await record(entry("failed", describe(err)));
    throw err;
  }
  await record(result.ok ? entry("done", change.detail?.(result.value)) : entry("failed", `${result.status} ${result.message}`));
  return result;
}

/** A page of the audit log, newest first. */
export async function auditLog(log: AuditLog, cursor: unknown): Promise<Result<{ entries: AuditEntry[]; cursor?: string }>> {
  try {
    return { ok: true, value: await log.list(typeof cursor === "string" && cursor ? cursor : undefined, 50) };
  } catch (err) {
    return { ok: false, status: 502, message: `Could not read the audit log: ${describe(err)}` };
  }
}
