import type { StorageReportStore } from "../app/ports.ts";

/** Next to the tokens file and the session key; the storage report itself skips `_meta/`. */
export const STORAGE_REPORT_KEY = "_meta/storage-report.json";

export class R2StorageReport implements StorageReportStore {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async read() {
    const object = await this.bucket.get(STORAGE_REPORT_KEY);
    return object ? object.json().catch(() => undefined) : undefined;
  }

  async write(report: unknown) {
    await this.bucket.put(STORAGE_REPORT_KEY, JSON.stringify(report), { httpMetadata: { contentType: "application/json" } });
  }
}
