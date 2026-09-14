import {
  addStoredToken,
  revokeStoredToken,
  type StoredToken,
  storedTokensIn,
  TOKENS_KEY,
  type TokenEdit,
  type TokensFile,
} from "../shared/contract.ts";
import type { Result } from "./lfs.ts";
import type { TokenMinter, TokensFileStore } from "./ports.ts";

export type TokenSummary = Omit<StoredToken, "sha256">;

const reject = (status: number, message: string): Result<never> => ({ ok: false, status, message });

async function load(store: TokensFileStore): Promise<Result<{ file: TokensFile; etag: string | null }>> {
  const { value, etag } = await store.read();
  if (etag === null) return { ok: true, value: { file: { version: 1, tokens: [] }, etag } };
  const tokens = storedTokensIn(value);
  if (!tokens) return reject(500, `${TOKENS_KEY} in the bucket is not a valid tokens file; fix or delete it`);
  return { ok: true, value: { file: { version: 1, tokens }, etag } };
}

async function save(store: TokensFileStore, edit: TokenEdit, etag: string | null): Promise<Result<StoredToken>> {
  if (!edit.ok) return reject(422, edit.message);
  if (!(await store.write(edit.file, etag))) return reject(409, "The tokens changed in the meantime; reload and try again");
  return { ok: true, value: edit.entry };
}

const summary = ({ sha256: _hash, ...rest }: StoredToken): TokenSummary => rest;

export async function listTokens(store: TokensFileStore): Promise<Result<TokenSummary[]>> {
  const loaded = await load(store);
  return loaded.ok ? { ok: true, value: loaded.value.file.tokens.map(summary) } : loaded;
}

export async function createToken(
  deps: { store: TokensFileStore; minter: TokenMinter; now: () => Date },
  input: { label?: unknown; scope?: unknown; permission?: unknown },
): Promise<Result<{ token: string; entry: TokenSummary }>> {
  const { label, scope, permission } = input;
  if (typeof label !== "string" || typeof scope !== "string") return reject(422, "label and scope are required");
  if (permission !== "read" && permission !== "write" && permission !== "admin")
    return reject(422, "permission must be read, write or admin");
  const loaded = await load(deps.store);
  if (!loaded.ok) return loaded;
  const minted = await deps.minter.mint();
  const edit = addStoredToken(loaded.value.file, {
    label: label.trim(),
    scope: scope.trim(),
    permission,
    id: minted.id,
    sha256: minted.sha256,
    created: deps.now(),
  });
  const saved = await save(deps.store, edit, loaded.value.etag);
  return saved.ok ? { ok: true, value: { token: minted.token, entry: summary(saved.value) } } : saved;
}

export async function revokeToken(store: TokensFileStore, id: unknown): Promise<Result<TokenSummary>> {
  if (typeof id !== "string" || !id) return reject(422, "id is required");
  const loaded = await load(store);
  if (!loaded.ok) return loaded;
  // By id only: labels are free text, and the UI always knows the id.
  const entry = loaded.value.file.tokens.find((t) => t.id === id);
  if (!entry) return reject(404, `No token with id ${id}`);
  const saved = await save(store, revokeStoredToken(loaded.value.file, entry.id), loaded.value.etag);
  return saved.ok ? { ok: true, value: summary(saved.value) } : saved;
}
