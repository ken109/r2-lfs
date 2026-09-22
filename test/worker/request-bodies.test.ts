import { describe, expect, it } from "vitest";

import { blob, call, envWith } from "./helpers.ts";

const WRITE = "w".repeat(32);
const ADMIN = "a".repeat(32);
const OTHER = "o".repeat(32);

const makeEnv = envWith({
  AUTH_MODE: "token",
  TRANSFER_MODE: "proxy",
  AUTH_TOKENS: `acme/*:rw:${WRITE},acme/*:admin:${ADMIN},acme/*:rw:${OTHER}`,
});

/** The status and message a body gets, sent as JSON (or as is when it is a string). */
async function answer(path: string, body: unknown, token = WRITE) {
  const res = await call(makeEnv(), path, typeof body === "string" ? { token, body } : { token, json: body });
  const json = (await res.json()) as { message?: string; objects?: { error?: { code: number; message: string } }[] };
  return { status: res.status, message: json.message, objects: json.objects };
}

describe("request bodies", () => {
  it("answers batch requests that are not what the spec describes with its statuses and the same messages", async () => {
    const batch = "/acme/bodies/objects/batch";
    expect(await answer(batch, [1])).toMatchObject({ status: 400, message: "Request body must be a JSON object" });
    expect(await answer(batch, "not json")).toMatchObject({ status: 400, message: "Request body must be a JSON object" });
    expect(await answer(batch, { operation: "move", objects: [] })).toMatchObject({
      status: 422,
      message: "operation must be upload or download",
    });
    expect(await answer(batch, { operation: "download", objects: [], hash_algo: "md5" })).toMatchObject({
      status: 409,
      message: "Only sha256 is supported",
    });
    expect(await answer(batch, { operation: "download", objects: {} })).toMatchObject({
      status: 422,
      message: "objects must be an array of at most 1000 entries",
    });
    const tooMany = Array.from({ length: 1001 }, () => ({ oid: "a".repeat(64), size: 1 }));
    expect(await answer(batch, { operation: "download", objects: tooMany })).toMatchObject({ status: 422 });

    const listed = await answer(batch, { operation: "upload", objects: [null, { oid: "x", size: 1 }, { oid: "a".repeat(64), size: -1 }] });
    expect(listed.status).toBe(200);
    expect(listed.objects?.map((o) => o.error)).toEqual(Array.from({ length: 3 }, () => ({ code: 422, message: "Invalid oid or size" })));
    expect(await answer("/acme/bodies/objects/verify", { oid: "a".repeat(64), size: 1.5 })).toMatchObject({
      status: 422,
      message: "Invalid oid or size",
    });
  });

  it("checks multipart bodies with the same messages", async () => {
    const { oid } = await blob(8);
    const base = `/acme/bodies/objects/${oid}/multipart`;
    expect(await answer(base, { size: "8" })).toMatchObject({ status: 422, message: "Invalid oid or size" });
    expect(await answer(base, null)).toMatchObject({ status: 422, message: "Invalid oid or size" });
    expect(await answer(`${base}/upload-1/complete`, { size: 8 })).toMatchObject({ status: 422, message: "size and parts are required" });
    expect(await answer(`${base}/upload-1/complete`, { size: 8, parts: [{ partNumber: "1", etag: "e" }] })).toMatchObject({
      status: 422,
      message: "Each part needs partNumber and etag",
    });
    expect(await answer(`${base}/upload-1/complete`, { size: 8, parts: [null] })).toMatchObject({
      status: 422,
      message: "Each part needs partNumber and etag",
    });
  });

  it("checks lock bodies with the same messages, and reads a verify body leniently", async () => {
    const repo = `/acme/bodies-${Date.now()}`;
    expect(await answer(`${repo}/locks`, { path: "  " })).toMatchObject({ status: 422, message: "path is required" });
    expect(await answer(`${repo}/locks`, [])).toMatchObject({ status: 422, message: "path is required" });
    expect(await answer(`${repo}/locks/verify`, { limit: 0 })).toMatchObject({ status: 422, message: "limit must be a positive integer" });
    expect(await answer(`${repo}/locks/verify`, { cursor: 5, limit: "2" })).toMatchObject({ status: 200 });
    expect(await answer(`${repo}/locks/verify`, "[]")).toMatchObject({ status: 200 });

    const created = await call(makeEnv(), `${repo}/locks`, { token: OTHER, json: { path: "scene.blend" } });
    const { lock } = (await created.json()) as { lock: { id: string } };
    const unlock = `${repo}/locks/${lock.id}/unlock`;
    expect(await answer(unlock, { force: "true" }, ADMIN)).toMatchObject({
      status: 403,
      message: "scene.blend is locked by AUTH_TOKENS #3",
    });
    expect(await answer(unlock, { force: true }, ADMIN)).toMatchObject({ status: 200 });
  });

  it("checks the oids of storage changes with the same message", async () => {
    const change = "/acme/bodies/r2-lfs/objects/trash";
    const message = "oids must be a non-empty array of SHA-256 oids";
    for (const body of [{}, { oids: [] }, { oids: ["A".repeat(64)] }, { oids: "a".repeat(64) }, null]) {
      expect(await answer(change, body, ADMIN)).toMatchObject({ status: 422, message });
    }
    expect(await answer(change, { oids: Array.from({ length: 11 }, (_, i) => i.toString(16).padStart(64, "0")) }, ADMIN)).toMatchObject({
      status: 422,
      message: "At most 10 oids per request",
    });
  });
});
