import { AwsClient } from "aws4fetch";

import type { ObjectCopier } from "../app/ports.ts";
import type { PresignCredentials } from "../domain/config.ts";
import type { Fetcher } from "./github-permissions.ts";

const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

/** Server-side copies through R2's S3 API, with the credentials presigned mode already has. */
export class S3Copier implements ObjectCopier {
  private readonly client: AwsClient;
  private readonly creds: PresignCredentials;
  private readonly fetcher: Fetcher;

  constructor(creds: PresignCredentials, fetcher: Fetcher) {
    this.creds = creds;
    this.fetcher = fetcher;
    this.client = new AwsClient({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, service: "s3", region: "auto" });
  }

  async copy(source: string, target: string): Promise<void> {
    const url = `https://${this.creds.accountId}.r2.cloudflarestorage.com/${this.creds.bucketName}/${encodeKey(target)}`;
    const signed = await this.client.sign(url, {
      method: "PUT",
      headers: { "x-amz-copy-source": `/${this.creds.bucketName}/${encodeKey(source)}` },
    });
    const res = await this.fetcher(signed);
    const text = await res.text();
    // S3 can report a failed copy inside a 200 response.
    if (!res.ok || text.includes("<Error>")) throw new Error(`copying ${source} to ${target} failed: ${res.status} ${text.slice(0, 200)}`);
  }
}
