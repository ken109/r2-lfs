import { env } from "cloudflare:test";

import type { Env } from "../../src/env.ts";
import { handle } from "../../src/http/handler.ts";
import type { Fetcher } from "../../src/infra/host-permissions.ts";

export const ORIGIN = "https://lfs.example.com";

/**
 * An `Env` factory for a test file: the test bucket and lock namespace, `acme/*` allowed, then the file's `defaults`,
 * then whatever a test overrides.
 */
export function envWith(defaults: Partial<Env>): (over?: Partial<Env>) => Env {
  return (over = {}) => ({ BUCKET: env.BUCKET, LOCKS: env.LOCKS, ALLOWED_REPOS: "acme/*", ...defaults, ...over });
}

/** Basic credentials the way git-lfs sends them. */
export const basic = (password: string, user = "git") => `Basic ${btoa(`${user}:${password}`)}`;

/** A Git host API that the request must not reach, as in token mode. */
export const noHost: Fetcher = () => {
  throw new Error("the host API must not be called");
};

export interface CallOptions {
  method?: string;
  /** Sent as Basic credentials, unless `authorization` is given. */
  token?: string;
  authorization?: string;
  body?: BodyInit;
  json?: unknown;
  headers?: Record<string, string>;
  fetcher?: Fetcher;
}

/** Sends a request to the LFS API, POST when it has a body. */
export function call(e: Env, path: string, opts: CallOptions = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  const authorization = opts.authorization ?? (opts.token ? basic(opts.token) : undefined);
  if (authorization) headers.set("Authorization", authorization);
  let body = opts.body;
  // Clients such as git-lfs send Content-Length; a Request built here would not have the header.
  if (body instanceof Uint8Array) headers.set("Content-Length", String(body.byteLength));
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers.set("Content-Type", "application/vnd.git-lfs+json");
  }
  const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
  const request = new Request(url, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
  return handle(request, e, { fetch: opts.fetcher ?? noHost });
}

/** Hex SHA-256. */
export async function sha256(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Random content, so each test works on objects no other test has stored. `tamper` changes a byte after hashing.
 * getRandomValues fills at most 65,536 bytes a call.
 */
export async function blob(size = 64, tamper = false): Promise<{ data: Uint8Array; oid: string; size: number }> {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i += 65_536) crypto.getRandomValues(data.subarray(i, Math.min(size, i + 65_536)));
  const oid = await sha256(data);
  if (tamper) data[0] = data[0]! ^ 1;
  return { data, oid, size };
}
