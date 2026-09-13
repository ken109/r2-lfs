import { INFO_PATH, type MisconfiguredInfo, type ServerInfo } from "../../src/shared/contract.ts";
import { type BatchObject, BatchRequestError, type InfoResult, type LfsClient } from "../app/ports.ts";
import type { ObjectRef } from "../domain/objects.ts";
import type { LfsLocation } from "../domain/remote.ts";

const BATCH_SIZE = 100;

/** Speaks the Git LFS batch API to an r2-lfs server. */
export class HttpLfsClient implements LfsClient {
  readonly location: LfsLocation;
  private readonly token: string | undefined;

  constructor(location: LfsLocation, token: string | undefined) {
    this.location = location;
    this.token = token;
  }

  get hasCredentials(): boolean {
    return this.token !== undefined;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.git-lfs+json",
      "Content-Type": "application/vnd.git-lfs+json",
    };
    if (this.token) headers.Authorization = `Basic ${Buffer.from(`r2-lfs:${this.token}`).toString("base64")}`;
    return headers;
  }

  async info(): Promise<InfoResult> {
    const res = await fetch(`${this.location.origin}${INFO_PATH}`);
    const body = (await res.json().catch(() => undefined)) as ServerInfo | MisconfiguredInfo | undefined;
    if (body?.name !== "r2-lfs") return { kind: "not-r2-lfs", status: res.status };
    if (!res.ok) return { kind: "misconfigured", problems: "problems" in body ? body.problems : [`status ${res.status}`] };
    return { kind: "ok", info: body as ServerInfo };
  }

  private async batchOnce(operation: "upload" | "download", objects: ObjectRef[]): Promise<BatchObject[]> {
    const res = await fetch(`${this.location.url}/objects/batch`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ operation, transfers: ["basic"], objects, hash_algo: "sha256" }),
    });
    const body = (await res.json().catch(() => ({}))) as { objects?: BatchObject[]; message?: string };
    if (!res.ok) throw new BatchRequestError(res.status, body.message ?? res.statusText);
    return body.objects ?? [];
  }

  async batch(operation: "upload" | "download", objects: ObjectRef[]): Promise<BatchObject[]> {
    if (objects.length === 0) return this.batchOnce(operation, []);
    const results: BatchObject[] = [];
    for (let i = 0; i < objects.length; i += BATCH_SIZE) {
      results.push(...(await this.batchOnce(operation, objects.slice(i, i + BATCH_SIZE))));
    }
    return results;
  }

  async download(object: BatchObject): Promise<AsyncIterable<Uint8Array>> {
    const action = object.actions?.download;
    if (!action) throw new Error(`no download action for ${object.oid}`);
    const res = await fetch(action.href, { headers: action.header });
    if (!res.ok || !res.body) throw new Error(`downloading ${object.oid} failed: ${res.status}`);
    return res.body as unknown as AsyncIterable<Uint8Array>;
  }
}
