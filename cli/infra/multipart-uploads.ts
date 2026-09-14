import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { LfsAction, MultipartStart } from "../../src/shared/contract.ts";
import { type MultipartUploads, type SavedUpload, TransferError, type UploadedPart, type UploadStates } from "../app/ports.ts";

/** Calls the Worker's multipart endpoints with the headers of the batch response's action. */
export class HttpMultipartUploads implements MultipartUploads {
  private async request(action: LfsAction, method: string, path: string, body?: Uint8Array | string): Promise<Response> {
    const headers = new Headers(action.header);
    if (typeof body === "string") headers.set("Content-Type", "application/vnd.git-lfs+json");
    let res: Response;
    try {
      res = await fetch(`${action.href}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
    } catch (err) {
      throw new TransferError(undefined, `${method} ${action.href}${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return res;
  }

  private static async fail(res: Response): Promise<never> {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new TransferError(res.status, body.message ?? `the server answered ${res.status}`);
  }

  async start(action: LfsAction, size: number): Promise<MultipartStart> {
    const res = await this.request(action, "POST", "", JSON.stringify({ size }));
    if (!res.ok) return HttpMultipartUploads.fail(res);
    return (await res.json()) as MultipartStart;
  }

  async uploadPart(action: LfsAction, uploadId: string, partNumber: number, data: Uint8Array): Promise<UploadedPart | undefined> {
    const res = await this.request(action, "PUT", `/${encodeURIComponent(uploadId)}/${partNumber}`, data);
    if (res.status === 404) {
      await res.body?.cancel();
      return undefined;
    }
    if (!res.ok) return HttpMultipartUploads.fail(res);
    return (await res.json()) as UploadedPart;
  }

  async complete(action: LfsAction, uploadId: string, size: number, parts: UploadedPart[]): Promise<void> {
    const res = await this.request(action, "POST", `/${encodeURIComponent(uploadId)}/complete`, JSON.stringify({ size, parts }));
    if (!res.ok) return HttpMultipartUploads.fail(res);
    await res.body?.cancel();
  }
}

/** One JSON file per object under the repository's git directory, written atomically. */
export class FileUploadStates implements UploadStates {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  static inGitDir(gitDir: string): FileUploadStates {
    return new FileUploadStates(join(gitDir, "lfs", "r2-lfs", "uploads"));
  }

  load(oid: string): SavedUpload | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${oid}.json`), "utf8")) as SavedUpload;
    } catch {
      return undefined;
    }
  }

  save(oid: string, state: SavedUpload): void {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${oid}.json`);
    // Several agents run at once, each on its own object, so a per-process temp name is enough.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state));
    renameSync(temp, file);
  }

  remove(oid: string): void {
    rmSync(join(this.dir, `${oid}.json`), { force: true });
  }
}

export async function readFileRange(path: string, offset: number, length: number): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const buffer = new Uint8Array(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await file.read(buffer, read, length - read, offset + read);
      if (bytesRead === 0) throw new Error(`${path} ended before byte ${offset + length}`);
      read += bytesRead;
    }
    return buffer;
  } finally {
    await file.close();
  }
}

/** Lines of standard input, as git-lfs writes its messages. */
export function stdinLines(): AsyncIterable<string> & { close(): void } {
  return createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
}
