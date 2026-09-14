import { AwsClient } from "aws4fetch";

import type { Action, TransferLinks } from "../app/ports.ts";
import type { PresignCredentials } from "../domain/config.ts";
import { ACTION_TTL_SECONDS } from "../shared/contract.ts";

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

/** Makes the Authorization header of an action: a token for this object's transfer only. */
export type ActionAuthorization = (oid: string, permission: "read" | "write") => Promise<string>;

/** Clients talk to R2 directly; only verification and multipart uploads come back to the Worker. */
export class PresignedLinks implements TransferLinks {
  readonly presigned = true;
  private readonly creds: PresignCredentials;
  private readonly baseUrl: string;
  private readonly authorize: ActionAuthorization;

  constructor(creds: PresignCredentials, baseUrl: string, authorize: ActionAuthorization) {
    this.creds = creds;
    this.baseUrl = baseUrl;
    this.authorize = authorize;
  }

  async download(key: string): Promise<Action> {
    return { href: await presignUrl(this.creds, key, "GET"), expires_in: PRESIGN_EXPIRES_SECONDS };
  }

  async upload(key: string): Promise<Action> {
    return { href: await presignUrl(this.creds, key, "PUT"), expires_in: PRESIGN_EXPIRES_SECONDS };
  }

  async verify(oid: string): Promise<Action> {
    return workerAction(`${this.baseUrl}/objects/verify`, await this.authorize(oid, "write"));
  }

  async multipart(oid: string): Promise<Action> {
    return workerAction(`${this.baseUrl}/objects/${oid}/multipart`, await this.authorize(oid, "write"));
  }
}

function workerAction(href: string, authorization: string): Action {
  return { href, header: { Authorization: authorization }, expires_in: ACTION_TTL_SECONDS };
}

/** Transfers stream through the Worker, each with a token for that object alone. */
export class ProxyLinks implements TransferLinks {
  readonly presigned = false;
  private readonly baseUrl: string;
  private readonly authorize: ActionAuthorization;

  constructor(baseUrl: string, authorize: ActionAuthorization) {
    this.baseUrl = baseUrl;
    this.authorize = authorize;
  }

  async download(_key: string, oid: string): Promise<Action> {
    return workerAction(`${this.baseUrl}/objects/${oid}`, await this.authorize(oid, "read"));
  }

  async upload(_key: string, oid: string): Promise<Action> {
    return workerAction(`${this.baseUrl}/objects/${oid}`, await this.authorize(oid, "write"));
  }

  async verify(oid: string): Promise<Action> {
    return workerAction(`${this.baseUrl}/objects/verify`, await this.authorize(oid, "write"));
  }

  async multipart(oid: string): Promise<Action> {
    return workerAction(`${this.baseUrl}/objects/${oid}/multipart`, await this.authorize(oid, "write"));
  }
}
