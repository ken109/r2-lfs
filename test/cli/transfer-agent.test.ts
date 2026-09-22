import { describe, expect, it } from "vitest";

import { type MultipartUploads, type SavedUpload, TransferError, type UploadedPart } from "../../cli/app/ports.ts";
import { runTransferAgent } from "../../cli/app/transfer-agent.ts";

describe("transfer agent", () => {
  const OID = "d".repeat(64);
  const action = { href: "https://lfs.example.com/acme/assets/objects/dd/multipart", header: { Authorization: "Basic x" } };
  const CONTENT = new TextEncoder().encode("abcdefghijkl");

  class FakeUploads implements MultipartUploads {
    started = 0;
    sent: number[] = [];
    completed: { uploadId: string; size: number; parts: UploadedPart[] }[] = [];
    /** Errors to throw, in order, before calls succeed. */
    failures: { on: "part" | "complete"; error: Error }[] = [];
    forget = false;

    private fail(on: "part" | "complete") {
      const index = this.failures.findIndex((f) => f.on === on);
      if (index >= 0) throw this.failures.splice(index, 1)[0]!.error;
    }
    async start() {
      this.started++;
      return { uploadId: `upload-${this.started}`, partSize: 5 };
    }
    async uploadPart(_action: unknown, uploadId: string, partNumber: number, data: Uint8Array) {
      this.fail("part");
      if (this.forget && uploadId === "saved") return undefined;
      this.sent.push(partNumber);
      return { partNumber, etag: `${uploadId}-${partNumber}-${data.byteLength}` };
    }
    async complete(_action: unknown, uploadId: string, size: number, parts: UploadedPart[]) {
      this.fail("complete");
      this.completed.push({ uploadId, size, parts });
    }
  }

  class MemoryStates {
    readonly map = new Map<string, SavedUpload>();
    load(oid: string) {
      const state = this.map.get(oid);
      return state && structuredClone(state);
    }
    save(oid: string, state: SavedUpload) {
      this.map.set(oid, structuredClone(state));
    }
    remove(oid: string) {
      this.map.delete(oid);
    }
  }

  async function run(uploads: FakeUploads, states: MemoryStates, messages: object[]) {
    const out: Record<string, unknown>[] = [];
    const sleeps: number[] = [];
    const deps = {
      uploads,
      states,
      readPart: async (_path: string, offset: number, length: number) => CONTENT.slice(offset, offset + length),
      sleep: async (ms: number) => void sleeps.push(ms),
    };
    async function* lines() {
      for (const m of messages) yield JSON.stringify(m);
    }
    await runTransferAgent(deps, lines(), (m) => out.push(m));
    return { out, sleeps };
  }

  const uploadMessage = { event: "upload", oid: OID, size: CONTENT.byteLength, path: "/tmp/x", action };

  it("uploads in parts, reports progress and completes, then forgets the upload", async () => {
    const uploads = new FakeUploads();
    const states = new MemoryStates();
    const { out } = await run(uploads, states, [
      { event: "init", operation: "upload" },
      uploadMessage,
      { event: "terminate" },
      uploadMessage,
    ]);
    expect(out[0]).toEqual({});
    expect(out.filter((m) => m.event === "progress").map((m) => m.bytesSoFar)).toEqual([5, 10, 12]);
    expect(out.at(-1)).toEqual({ event: "complete", oid: OID });
    expect(uploads.completed).toEqual([
      { uploadId: "upload-1", size: 12, parts: [1, 2, 3].map((n) => ({ partNumber: n, etag: `upload-1-${n}-${n === 3 ? 2 : 5}` })) },
    ]);
    expect(states.map.size).toBe(0);
    // Nothing is read after terminate.
    expect(uploads.started).toBe(1);
  });

  it("continues an interrupted upload from the parts the server already has", async () => {
    const uploads = new FakeUploads();
    const states = new MemoryStates();
    states.save(OID, { href: action.href, size: 12, uploadId: "saved", partSize: 5, parts: [{ partNumber: 1, etag: "kept" }] });
    const { out } = await run(uploads, states, [uploadMessage]);
    expect(uploads.started).toBe(0);
    expect(uploads.sent).toEqual([2, 3]);
    expect(uploads.completed[0]?.parts[0]).toEqual({ partNumber: 1, etag: "kept" });
    expect(out.at(-1)).toEqual({ event: "complete", oid: OID });
  });

  it("starts over when the server no longer has the saved upload", async () => {
    const uploads = new FakeUploads();
    uploads.forget = true;
    const states = new MemoryStates();
    states.save(OID, { href: action.href, size: 12, uploadId: "saved", partSize: 5, parts: [{ partNumber: 1, etag: "kept" }] });
    const { out } = await run(uploads, states, [uploadMessage]);
    expect(uploads.started).toBe(1);
    expect(uploads.completed[0]?.uploadId).toBe("upload-1");
    expect(out.at(-1)).toEqual({ event: "complete", oid: OID });
  });

  it("retries dropped connections and server errors, but not refusals", async () => {
    const uploads = new FakeUploads();
    uploads.failures = [
      { on: "part", error: new TransferError(undefined, "socket hang up") },
      { on: "part", error: new TransferError(503, "busy") },
    ];
    const states = new MemoryStates();
    const { out, sleeps } = await run(uploads, states, [uploadMessage]);
    expect(sleeps).toEqual([500, 1000]);
    expect(out.at(-1)).toEqual({ event: "complete", oid: OID });

    const refused = new FakeUploads();
    refused.failures = [{ on: "complete", error: new TransferError(422, "Uploaded content does not match the oid and size") }];
    const result = await run(refused, states, [uploadMessage]);
    expect(result.sleeps).toEqual([]);
    expect(result.out.at(-1)).toEqual({
      event: "complete",
      oid: OID,
      error: { code: 422, message: expect.stringContaining("does not match") },
    });
    expect(states.map.size).toBe(0);
  });

  it("keeps the upload for the next push when the server stays unreachable", async () => {
    const uploads = new FakeUploads();
    uploads.failures = Array.from({ length: 4 }, () => ({ on: "complete" as const, error: new TransferError(undefined, "offline") }));
    const states = new MemoryStates();
    const { out } = await run(uploads, states, [uploadMessage]);
    expect(out.at(-1)).toMatchObject({ event: "complete", error: { message: "offline" } });
    expect(states.load(OID)?.parts).toHaveLength(3);
  });

  it("declines downloads, which stay with git-lfs's own resumable transfer", async () => {
    const { out } = await run(new FakeUploads(), new MemoryStates(), [
      { event: "init", operation: "download" },
      { event: "download", oid: OID },
    ]);
    expect(out[0]).toMatchObject({ error: { message: expect.stringContaining("only uploads") } });
    expect(out[1]).toMatchObject({ event: "complete", oid: OID, error: { code: 1 } });
  });
});
