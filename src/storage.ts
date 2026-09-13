import { AwsClient } from "aws4fetch";
import type { Repo } from "./auth.ts";
import type { Config, PresignCredentials } from "./config.ts";

export const OID_PATTERN = /^[0-9a-f]{64}$/;
export const PRESIGN_EXPIRES_SECONDS = 3600;

/**
 * GitHub names are case-insensitive, so keys are lowercased to keep one prefix per repository.
 * `_shared` cannot collide with an owner: GitHub logins never start with an underscore.
 */
export function objectKey(config: Config, repo: Repo, oid: string): string {
  return config.storageLayout === "shared"
    ? `_shared/${oid}`
    : `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}/${oid}`;
}

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
