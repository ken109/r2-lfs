import type { AuditEntry, AuditLog } from "../app/ports.ts";

export const AUDIT_PREFIX = "_meta/audit/";

/** Keys sort by time left until this moment, so R2's ascending listing returns the newest first. */
const END_OF_TIME = 9_999_999_999_999;

/** R2 limits custom metadata to 2 KiB per object; details are cut well below that. */
const MAX_DETAIL = 500;

const OUTCOMES = new Set(["done", "failed", "refused"]);

/**
 * One object per entry under `_meta/audit/`, with the entry in its custom metadata as well as its body, so a page of
 * the log takes one list request. Nothing expires them; they are small.
 */
export class R2AuditLog implements AuditLog {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async record(entry: AuditEntry) {
    const time = Date.parse(entry.at);
    const random = crypto.getRandomValues(new Uint8Array(4)).reduce((hex, b) => hex + b.toString(16).padStart(2, "0"), "");
    const key = `${AUDIT_PREFIX}${String(END_OF_TIME - time).padStart(13, "0")}-${random}`;
    const stored = { ...entry, ...(entry.detail ? { detail: entry.detail.slice(0, MAX_DETAIL) } : {}) };
    await this.bucket.put(key, JSON.stringify(stored), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, String(v)])),
    });
  }

  async list(cursor: string | undefined, limit: number) {
    const page = await this.bucket.list({ prefix: AUDIT_PREFIX, limit, include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
    const entries = page.objects.flatMap((object): AuditEntry[] => {
      const m = object.customMetadata ?? {};
      if (!m.at || !m.email || !m.action || m.target === undefined || !m.outcome || !OUTCOMES.has(m.outcome)) return [];
      return [
        {
          at: m.at,
          email: m.email,
          action: m.action,
          target: m.target,
          outcome: m.outcome as AuditEntry["outcome"],
          ...(m.detail ? { detail: m.detail } : {}),
        },
      ];
    });
    return { entries, ...(page.truncated ? { cursor: page.cursor } : {}) };
  }
}
