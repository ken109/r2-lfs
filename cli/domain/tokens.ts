import { SCOPE_PATTERN, type StoredToken, storedTokensIn, TOKENS_KEY, type TokensFile } from "../../src/shared/contract.ts";
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

export interface NewToken {
  label: string;
  scope: string;
  readOnly: boolean;
  id: string;
  sha256: string;
  created: Date;
}

export function addToken(file: TokensFile, input: NewToken): { file: TokensFile; entry: StoredToken } {
  if (!SCOPE_PATTERN.test(input.scope)) throw new UsageError("scope must be owner/repo, owner/* or *");
  if (!input.label.trim()) throw new UsageError("label must not be empty");
  if (file.tokens.some((t) => t.label === input.label)) throw new UsageError(`a token labelled ${input.label} already exists`);
  const entry: StoredToken = {
    id: input.id,
    label: input.label,
    scope: input.scope.toLowerCase(),
    permission: input.readOnly ? "read" : "write",
    sha256: input.sha256,
    created: input.created.toISOString(),
  };
  return { file: { ...file, tokens: [...file.tokens, entry] }, entry };
}

export function revokeToken(file: TokensFile, idOrLabel: string): { file: TokensFile; entry: StoredToken } {
  const entry = file.tokens.find((t) => t.id === idOrLabel || t.label === idOrLabel);
  if (!entry) throw new UsageError(`no token with id or label ${idOrLabel}`);
  return { file: { ...file, tokens: file.tokens.filter((t) => t !== entry) }, entry };
}
