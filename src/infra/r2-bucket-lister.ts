import type { BucketLister } from "../app/ports.ts";

export class R2BucketLister implements BucketLister {
  private readonly bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.bucket = bucket;
  }

  async list(cursor: string | undefined) {
    const page = await this.bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    return {
      objects: page.objects.map((o) => ({ key: o.key, size: o.size })),
      ...(page.truncated ? { cursor: page.cursor } : {}),
    };
  }
}
