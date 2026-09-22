import { INFO_PATH, type MisconfiguredInfo, type ServerInfo, SESSION_ENDPOINT, type SessionResponse } from "../../src/shared/contract.ts";
import { type BatchObject, BatchRequestError, type InfoResult, type LfsClient, type Session } from "../app/ports.ts";
import type { ObjectRef } from "../domain/objects.ts";
import type { LfsLocation } from "../domain/remote.ts";

const BATCH_SIZE = 100;

/** An answer from a repository's LFS URL: the response, and its JSON body unless it had none. */
export interface LfsAnswer<T> {
  res: Response;
  body: (T & { message?: string }) | undefined;
}

/** Requests to a repository's LFS URL with the headers git-lfs sends, and the token as Basic credentials. */
export class LfsEndpoint {
  readonly location: LfsLocation;
  readonly token: string | undefined;

  constructor(location: LfsLocation, token: string | undefined) {
    this.location = location;
    this.token = token;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.git-lfs+json",
      "Content-Type": "application/vnd.git-lfs+json",
    };
    if (this.token) headers.Authorization = `Basic ${Buffer.from(`r2-lfs:${this.token}`).toString("base64")}`;
    return headers;
  }

  /** `path` is relative to the LFS URL, such as `objects/batch`. */
  async request<T>(path: string, init: { method?: string; body?: string } = {}): Promise<LfsAnswer<T>> {
    const res = await fetch(`${this.location.url}/${path}`, { ...init, headers: this.headers() });
    const body = (await res.json().catch(() => undefined)) as LfsAnswer<T>["body"];
    return { res, body };
  }
}

/** What an error answer says went wrong: its message, or the status text. */
export const errorMessage = ({ res, body }: LfsAnswer<unknown>): string => body?.message ?? res.statusText;

/** Speaks the Git LFS batch API to an r2-lfs server. */
export class HttpLfsClient implements LfsClient {
  readonly location: LfsLocation;
  private readonly endpoint: LfsEndpoint;
  private infoAnswer: Promise<InfoResult> | undefined;

  constructor(location: LfsLocation, token: string | undefined) {
    this.location = location;
    this.endpoint = new LfsEndpoint(location, token);
  }

  get hasCredentials(): boolean {
    return this.endpoint.token !== undefined;
  }

  /** Asked once per client: the settings do not change while a command runs. */
  info(): Promise<InfoResult> {
    this.infoAnswer ??= this.fetchInfo().catch((err: unknown) => {
      this.infoAnswer = undefined;
      throw err;
    });
    return this.infoAnswer;
  }

  private async fetchInfo(): Promise<InfoResult> {
    const res = await fetch(`${this.location.origin}${INFO_PATH}`);
    const body = (await res.json().catch(() => undefined)) as ServerInfo | MisconfiguredInfo | undefined;
    if (body?.name !== "r2-lfs") return { kind: "not-r2-lfs", status: res.status };
    if (!res.ok) return { kind: "misconfigured", problems: "problems" in body ? body.problems : [`status ${res.status}`] };
    return { kind: "ok", info: body as ServerInfo };
  }

  async session(): Promise<Session | undefined> {
    if (!this.endpoint.token) return undefined;
    const { res, body } = await this.endpoint.request<Partial<SessionResponse>>(SESSION_ENDPOINT, { method: "POST" });
    if (!res.ok) return undefined;
    const expiresAt = new Date(body?.expires_at ?? Number.NaN);
    return typeof body?.token === "string" && !Number.isNaN(expiresAt.getTime()) ? { token: body.token, expiresAt } : undefined;
  }

  private async batchOnce(operation: "upload" | "download", objects: ObjectRef[]): Promise<BatchObject[]> {
    const answer = await this.endpoint.request<{ objects?: BatchObject[] }>("objects/batch", {
      method: "POST",
      body: JSON.stringify({ operation, transfers: ["basic"], objects, hash_algo: "sha256" }),
    });
    if (!answer.res.ok) throw new BatchRequestError(answer.res.status, errorMessage(answer));
    return answer.body?.objects ?? [];
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
