import type { StoredToken, TokensFile } from "../../src/shared/contract.ts";
import { UsageError } from "./errors.ts";

const SCOPE = /^(\*|[A-Za-z0-9-]+\/(\*|[A-Za-z0-9._-]+))$/;

export function emptyTokensFile(): TokensFile {
  return { version: 1, tokens: [] };
}

export function parseTokensFile(text: string): TokensFile {
  let file: TokensFile;
  try {
    file = JSON.parse(text) as TokensFile;
  } catch {
    throw new Error("the tokens file is not valid JSON");
  }
  if (file.version !== 1 || !Array.isArray(file.tokens)) throw new Error("the tokens file has an unexpected format");
  return file;
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
  if (!SCOPE.test(input.scope)) throw new UsageError("scope must be owner/repo, owner/* or *");
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
