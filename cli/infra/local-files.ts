import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Files } from "../app/ports.ts";
import type { TarEntry } from "../domain/tar.ts";
import { TarWriter } from "./tar-writer.ts";

export class LocalFiles implements Files {
  sizeOf(path: string): number | undefined {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  }

  readText(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }

  writeExecutable(path: string, text: string): void {
    writeFileSync(path, text);
    chmodSync(path, 0o755);
  }

  mkdirp(path: string): void {
    mkdirSync(path, { recursive: true });
  }

  writeText(path: string, text: string): void {
    writeFileSync(path, text);
  }

  copyFile(from: string, to: string): void {
    copyFileSync(from, to);
  }

  copyDir(from: string, to: string): void {
    cpSync(from, to, { recursive: true });
  }

  async sha256(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  async writeTar(path: string, entries: readonly TarEntry[], onEntry?: (entry: TarEntry) => void): Promise<void> {
    const writer = new TarWriter(path);
    for (const entry of entries) {
      await writer.add(entry);
      onEntry?.(entry);
    }
    await writer.close();
  }

  tempDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
  }
}
