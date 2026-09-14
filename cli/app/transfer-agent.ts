// The git-lfs custom transfer protocol: one JSON message per line on stdin, answers on stdout.
// https://github.com/git-lfs/git-lfs/blob/main/docs/custom-transfers.md

import { type LfsAction, MULTIPART_TRANSFER } from "../../src/shared/contract.ts";
import { type AgentTarget, launcherFileName, launcherScript } from "../domain/agent-launcher.ts";
import { type Files, type GlobalGitConfig, type MultipartUploads, type SavedUpload, TransferError, type UploadStates } from "./ports.ts";

export interface AgentDeps {
  uploads: MultipartUploads;
  states: UploadStates;
  readPart(path: string, offset: number, length: number): Promise<Uint8Array>;
  /** Waits before a retry; injectable so tests do not sleep. */
  sleep(ms: number): Promise<void>;
  /** Attempts per request before the transfer fails. */
  attempts?: number;
}

type Message =
  | { event: "init"; operation: "upload" | "download" }
  | { event: "upload"; oid: string; size: number; path: string; action: LfsAction }
  | { event: "download"; oid: string }
  | { event: "terminate" };

export type Emit = (message: Record<string, unknown>) => void;

/** Server errors and dropped connections are worth another try; a 4xx will answer the same way again. */
function retryable(err: unknown): boolean {
  return !(err instanceof TransferError) || err.status === undefined || err.status === 429 || err.status >= 500;
}

async function withRetries<T>(deps: AgentDeps, work: () => Promise<T>): Promise<T> {
  const attempts = deps.attempts ?? 4;
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (attempt >= attempts || !retryable(err)) throw err;
      await deps.sleep(500 * 2 ** (attempt - 1));
    }
  }
}

async function upload(deps: AgentDeps, message: Extract<Message, { event: "upload" }>, emit: Emit): Promise<void> {
  const { oid, size, path, action } = message;
  const saved = deps.states.load(oid);
  const state: SavedUpload =
    saved?.href === action.href && saved.size === size
      ? saved
      : { href: action.href, size, ...(await withRetries(deps, () => deps.uploads.start(action, size))), parts: [] };
  deps.states.save(oid, state);

  const partCount = Math.max(1, Math.ceil(size / state.partSize));
  const done = new Set(state.parts.map((p) => p.partNumber));
  let sent = 0;
  const progress = (bytes: number) => {
    sent += bytes;
    emit({ event: "progress", oid, bytesSoFar: sent, bytesSinceLast: bytes });
  };
  for (const partNumber of done) progress(Math.min(state.partSize, size - (partNumber - 1) * state.partSize));

  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    if (done.has(partNumber)) continue;
    const offset = (partNumber - 1) * state.partSize;
    const data = await deps.readPart(path, offset, Math.min(state.partSize, size - offset));
    const part = await withRetries(deps, () => deps.uploads.uploadPart(action, state.uploadId, partNumber, data));
    if (!part) {
      // The server forgot the upload, such as after its bucket rule aborted it; start again from the first part.
      deps.states.remove(oid);
      if (saved) return upload(deps, message, emit);
      throw new TransferError(404, "the server lost the upload while it was in progress");
    }
    state.parts.push(part);
    deps.states.save(oid, state);
    progress(data.byteLength);
  }

  const parts = state.parts.toSorted((a, b) => a.partNumber - b.partNumber);
  try {
    await withRetries(deps, () => deps.uploads.complete(action, state.uploadId, size, parts));
  } catch (err) {
    // A refused upload (the content does not match) would be refused again; anything else may resume.
    if (err instanceof TransferError && err.status !== undefined && err.status < 500) deps.states.remove(oid);
    throw err;
  }
  deps.states.remove(oid);
}

/** Answers git-lfs until it says terminate. Each process handles one transfer at a time. */
export async function runTransferAgent(deps: AgentDeps, lines: AsyncIterable<string>, emit: Emit): Promise<void> {
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as Message;
    switch (message.event) {
      case "init":
        emit(
          message.operation === "upload"
            ? {}
            : {
                error: {
                  code: 1,
                  message: `${MULTIPART_TRANSFER} only uploads; set lfs.customtransfer.${MULTIPART_TRANSFER}.direction to upload`,
                },
              },
        );
        break;
      case "upload":
        try {
          await upload(deps, message, emit);
          emit({ event: "complete", oid: message.oid });
        } catch (err) {
          const status = err instanceof TransferError ? err.status : undefined;
          emit({
            event: "complete",
            oid: message.oid,
            error: { code: status ?? 1, message: err instanceof Error ? err.message : String(err) },
          });
        }
        break;
      case "download":
        emit({ event: "complete", oid: message.oid, error: { code: 1, message: `${MULTIPART_TRANSFER} only uploads` } });
        break;
      case "terminate":
        return;
    }
  }
}

/** The git config that makes git-lfs offer the agent to servers; servers that do not know it keep using basic. */
export interface AgentInstallDeps {
  files: Files;
  gitConfig: GlobalGitConfig;
  platform: string;
  /** Where the launcher is written, e.g. ~/.config/r2-lfs. */
  configDir: string;
  /** Joins path segments the platform's way. */
  join(...parts: string[]): string;
}

/** Writes the launcher and points git-lfs at it. Returns the launcher's path. */
export function installTransferAgent(deps: AgentInstallDeps, target: AgentTarget): string {
  deps.files.mkdirp(deps.configDir);
  const launcher = deps.join(deps.configDir, launcherFileName(deps.platform));
  deps.files.writeExecutable(launcher, launcherScript(deps.platform, target));
  for (const [key, value] of transferAgentConfig(launcher, "")) deps.gitConfig.set(key, value);
  return launcher;
}

/** npm clears its npx cache, so a launcher falling back to a CLI there stops working unless r2-lfs is on PATH. */
export function inNpxCache(cli: string): boolean {
  return /[\\/]_npx[\\/]/.test(cli);
}

export function transferAgentConfig(path: string, args: string): [string, string][] {
  const prefix = `lfs.customtransfer.${MULTIPART_TRANSFER}`;
  return [
    [`${prefix}.path`, path],
    [`${prefix}.args`, args],
    [`${prefix}.concurrent`, "true"],
    [`${prefix}.direction`, "upload"],
  ];
}
