// The shapes of request bodies the LFS API accepts. Use cases check a body against these and answer with the
// message the spec or the endpoint prescribes, so the schemas carry no messages of their own.

import * as v from "valibot";

import { OID_PATTERN } from "../shared/contract.ts";

/** `body` as `schema` reads it, or undefined when it does not fit. */
export function read<S extends v.GenericSchema>(schema: S, body: unknown): v.InferOutput<S> | undefined {
  const parsed = v.safeParse(schema, body);
  return parsed.success ? parsed.output : undefined;
}

export const Oid = v.pipe(v.string(), v.regex(OID_PATTERN));
export const Size = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** An object named in a batch or verify request. */
export const ObjectSpec = v.object({ oid: Oid, size: Size });

/** Any JSON object, whatever its fields. */
export const JsonObject = v.looseObject({});

/** One entry of a batch request's `objects`, read as far as it goes; invalid ones are reported per object. */
export const BatchEntry = v.object({ oid: v.optional(v.unknown()), size: v.optional(v.unknown()) });

export const Operation = v.picklist(["upload", "download"]);

/** POST /objects/<oid>/multipart */
export const MultipartStartRequest = v.object({ size: Size });

/** POST /objects/<oid>/multipart/<uploadId>/complete, before its parts are checked. */
export const MultipartCompleteRequest = v.object({ size: Size, parts: v.array(v.unknown()) });

export const UploadedParts = v.array(v.object({ partNumber: v.number(), etag: v.string() }));

/** POST /locks */
export const CreateLockRequest = v.object({
  path: v.pipe(
    v.string(),
    v.check((path) => path.trim() !== ""),
  ),
});

/** POST /locks/verify; a body without these fields lists the first page. */
export const VerifyLocksRequest = v.object({
  cursor: v.fallback(v.optional(v.string()), undefined),
  limit: v.optional(v.unknown()),
});

/** POST /locks/:id/unlock that asks to remove someone else's lock. */
export const ForceUnlockRequest = v.object({ force: v.literal(true) });

/** POST <repository>/r2-lfs/objects/<action> */
export const StorageChangeRequest = v.object({ oids: v.pipe(v.array(Oid), v.minLength(1)) });
