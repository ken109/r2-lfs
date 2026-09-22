import {
  addStoredToken,
  type NewStoredToken,
  readTokensFile,
  revokeStoredToken,
  type StoredToken,
  type TokenEdit,
  TOKENS_KEY,
  type TokensFile,
} from "../../src/shared/contract.ts";
import { UsageError } from "./errors.ts";

export { emptyTokensFile } from "../../src/shared/contract.ts";

/** The tokens file as stored; `undefined`, for no file yet, is an empty one. */
export function parseTokensFile(text: string | undefined): TokensFile {
  const read = readTokensFile(text);
  if (read.ok) return read.file;
  throw new UsageError(
    read.problem === "not-json"
      ? `${TOKENS_KEY} in the bucket is not valid JSON; fix or delete it`
      : `${TOKENS_KEY} in the bucket has an unexpected format; fix or delete it`,
  );
}

export type NewToken = NewStoredToken;

function unwrap(edit: TokenEdit): { file: TokensFile; entry: StoredToken } {
  if (!edit.ok) throw new UsageError(edit.message);
  return { file: edit.file, entry: edit.entry };
}

export function addToken(file: TokensFile, input: NewToken): { file: TokensFile; entry: StoredToken } {
  return unwrap(addStoredToken(file, input));
}

export function revokeToken(file: TokensFile, idOrLabel: string): { file: TokensFile; entry: StoredToken } {
  return unwrap(revokeStoredToken(file, idOrLabel));
}
