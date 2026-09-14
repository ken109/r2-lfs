import {
  addStoredToken,
  type NewStoredToken,
  revokeStoredToken,
  type StoredToken,
  storedTokensIn,
  type TokenEdit,
  TOKENS_KEY,
  type TokensFile,
} from "../../src/shared/contract.ts";
import { UsageError } from "./errors.ts";

export function emptyTokensFile(): TokensFile {
  return { version: 1, tokens: [] };
}

export function parseTokensFile(text: string): TokensFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${TOKENS_KEY} in the bucket is not valid JSON; fix or delete it`);
  }
  const tokens = storedTokensIn(value);
  if (!tokens) throw new UsageError(`${TOKENS_KEY} in the bucket has an unexpected format; fix or delete it`);
  return { version: 1, tokens };
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
