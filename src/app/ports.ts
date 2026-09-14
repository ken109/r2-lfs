import type { Grant, Permission } from "../domain/access.ts";
import type { AccessSettings } from "../domain/config.ts";
import type { Repo } from "../domain/repo.ts";
import type { LfsAction } from "../shared/contract.ts";

/** Where LFS objects live. */
export interface ObjectStore {
  head(key: string): Promise<{ size: number } | null>;
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
  /** Stores `body` only if it hashes to `sha256`. */
  put(key: string, body: ReadableStream, sha256: string): Promise<"stored" | "checksum-mismatch">;
}

export type Action = LfsAction;

/** How clients reach an object: presigned R2 URLs, or back through this Worker. */
export interface TransferLinks {
  readonly presigned: boolean;
  download(key: string, oid: string): Promise<Action>;
  upload(key: string, oid: string): Promise<Action>;
  verify(): Action;
}

/** Grants whose secret equals the presented token. */
export interface TokenDirectory {
  grantsFor(token: string): Promise<Grant[]>;
}

export type Lookup = { ok: true; permission: Permission } | { ok: false; status: 401 | 403 | 404 | 502 | 503; message: string };

/** Checks a Cloudflare Access token: signature, audience, issuer and lifetime. */
export interface AccessVerifier {
  /** The signed-in user's email, or undefined when the token is not valid for the application. */
  verify(token: string, settings: AccessSettings): Promise<string | undefined>;
}

export interface GithubPermissions {
  lookup(repo: Repo, token: string): Promise<Lookup>;
}
