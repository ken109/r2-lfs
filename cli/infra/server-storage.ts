import {
  MAX_STORAGE_CHANGES,
  repoPrefix,
  STORAGE_ENDPOINT,
  type StorageAction,
  type StorageChanges,
  type StorageListing,
  TRASH_PREFIX,
} from "../../src/shared/contract.ts";
import type { ObjectStorage, Outcome, RestoredObject, StorageSupport } from "../app/ports.ts";
import { UsageError } from "../domain/errors.ts";
import { oidOfKey, type StoredObject } from "../domain/objects.ts";
import type { LfsLocation } from "../domain/remote.ts";
import { errorMessage, LfsEndpoint } from "./lfs-client.ts";

type Change = StorageChanges["results"][number];

/** A repository's objects through the server's storage endpoints, with the permissions the server gives the credentials. */
export class ServerStorage implements ObjectStorage {
  readonly supports: StorageSupport = { sharedLayout: false, deleteWithoutTrash: false, encryptedObjects: true };
  private readonly location: LfsLocation;
  private readonly endpoint: LfsEndpoint;

  constructor(location: LfsLocation, token: string) {
    this.location = location;
    this.endpoint = new LfsEndpoint(location, token);
  }

  get name(): string {
    return this.location.host;
  }

  private async request<T>(path: string, init: { method?: string; body?: string } = {}): Promise<T> {
    const answer = await this.endpoint.request<T>(`${STORAGE_ENDPOINT}${path}`, init);
    if (answer.res.ok && answer.body) return answer.body;
    if (answer.res.status === 404 && !answer.body?.message) {
      throw new UsageError(`${this.location.origin} cannot list or change objects; upgrade the server, or set the R2_* variables`);
    }
    throw new UsageError(`${this.location.origin} answered ${answer.res.status}: ${errorMessage(answer)}`);
  }

  /** The server keeps every repository in the per-repo layout, whatever `layout` says. */
  async list(where: "live" | "trash"): Promise<StoredObject[]> {
    const live = repoPrefix("per-repo", this.location.owner, this.location.repo);
    const prefix = where === "live" ? live : `${TRASH_PREFIX}${live}`;
    const objects: StoredObject[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ in: where, ...(cursor ? { cursor } : {}) });
      const page = await this.request<StorageListing>(`?${query}`);
      for (const o of page.objects) {
        objects.push({ key: `${prefix}${o.oid}`, size: o.size, lastModified: new Date(o.uploaded), storageClass: o.storage_class });
      }
      cursor = page.cursor;
    } while (cursor);
    return objects;
  }

  private async change(action: StorageAction, objects: readonly StoredObject[], progress: (done: number) => void) {
    const results = new Map<string, Change>();
    for (let i = 0; i < objects.length; i += MAX_STORAGE_CHANGES) {
      const batch = objects.slice(i, i + MAX_STORAGE_CHANGES);
      const oids = batch.map((o) => oidOfKey(o.key)).filter((oid): oid is string => oid !== undefined);
      const answer = await this.request<StorageChanges>(`/${action}`, { method: "POST", body: JSON.stringify({ oids }) });
      for (const result of answer.results) results.set(result.oid, result);
      progress(batch.length);
    }
    return objects.map((o) => ({ key: o.key, result: results.get(oidOfKey(o.key) ?? "") }));
  }

  async trash(objects: readonly StoredObject[], progress: (done: number) => void): Promise<Outcome[]> {
    return (await this.change("trash", objects, progress)).map(({ key, result }): Outcome => {
      if (result?.outcome === "trashed") return { key, action: "trashed", ok: true };
      if (result?.outcome === "locked") return { key, action: "locked", ok: true };
      return { key, action: "trash", ok: false, message: result?.message ?? result?.outcome ?? "no answer for this object" };
    });
  }

  /** Not supported: gc checks `supports.deleteWithoutTrash` first. */
  async delete(): Promise<Outcome[]> {
    throw new Error("the server does not delete objects without the trash");
  }

  async tier(objects: readonly StoredObject[], progress: (done: number) => void): Promise<Outcome[]> {
    return (await this.change("tier", objects, progress)).map(({ key, result }): Outcome => {
      if (result?.outcome === "tiered") return { key, action: "tiered", ok: true };
      if (result?.outcome === "locked") return { key, action: "locked", ok: true };
      return { key, action: "tier", ok: false, message: result?.message ?? result?.outcome ?? "no answer for this object" };
    });
  }

  async restore(objects: readonly StoredObject[], progress: (done: number) => void): Promise<RestoredObject[]> {
    return (await this.change("restore", objects, progress)).map(({ key, result }) =>
      result?.outcome === "restored"
        ? { key, ok: true }
        : { key, ok: false, message: result?.message ?? result?.outcome ?? "no answer for this object" },
    );
  }
}
