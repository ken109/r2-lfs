import { AwsClient } from "aws4fetch";

import type { Action, TransferLinks } from "../app/ports.ts";
import type { PresignCredentials } from "../domain/config.ts";

export const PRESIGN_EXPIRES_SECONDS = 3600;

export async function presignUrl(
  creds: PresignCredentials,
  key: string,
  method: "GET" | "PUT",
  expiresIn = PRESIGN_EXPIRES_SECONDS,
): Promise<string> {
  const client = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = new URL(`https://${creds.accountId}.r2.cloudflarestorage.com/${creds.bucketName}/${key}`);
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  const signed = await client.sign(new Request(url, { method }), { aws: { signQuery: true } });
  return signed.url;
}

/** Clients talk to R2 directly; only verification comes back to the Worker. */
export class PresignedLinks implements TransferLinks {
  readonly presigned = true;
  private readonly creds: PresignCredentials;
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(creds: PresignCredentials, baseUrl: string, authorization: string) {
    this.creds = creds;
    this.baseUrl = baseUrl;
    this.authorization = authorization;
  }

  async download(key: string): Promise<Action> {
    return { href: await presignUrl(this.creds, key, "GET"), expires_in: PRESIGN_EXPIRES_SECONDS };
  }

  async upload(key: string): Promise<Action> {
    return { href: await presignUrl(this.creds, key, "PUT"), expires_in: PRESIGN_EXPIRES_SECONDS };
  }

  verify(): Action {
    return { href: `${this.baseUrl}/objects/verify`, header: { Authorization: this.authorization } };
  }
}

/** Transfers stream through the Worker; the client's own credentials authenticate each one. */
export class ProxyLinks implements TransferLinks {
  readonly presigned = false;
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(baseUrl: string, authorization: string) {
    this.baseUrl = baseUrl;
    this.authorization = authorization;
  }

  async download(_key: string, oid: string): Promise<Action> {
    return { href: `${this.baseUrl}/objects/${oid}`, header: { Authorization: this.authorization } };
  }

  async upload(_key: string, oid: string): Promise<Action> {
    return { href: `${this.baseUrl}/objects/${oid}`, header: { Authorization: this.authorization } };
  }

  verify(): Action {
    return { href: `${this.baseUrl}/objects/verify`, header: { Authorization: this.authorization } };
  }
}
