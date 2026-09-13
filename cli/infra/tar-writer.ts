import { once } from "node:events";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";

import { END_BYTES, encodeHeader, paddingFor, paxRecordsFor, type TarEntry } from "../domain/tar.ts";

/** Streams entries into a tar file without holding file contents in memory. */
export class TarWriter {
  private readonly out: WriteStream;
  private readonly mtime = Math.floor(Date.now() / 1000);

  constructor(path: string) {
    this.out = createWriteStream(path);
  }

  private async write(chunk: Uint8Array): Promise<void> {
    if (!this.out.write(chunk)) await once(this.out, "drain");
  }

  async add(entry: TarEntry): Promise<void> {
    const pax = paxRecordsFor(entry);
    if (pax) {
      await this.write(encodeHeader({ name: "PaxHeader", size: pax.length, mode: 0o644, mtime: this.mtime, type: "x" }));
      await this.write(pax);
      await this.write(new Uint8Array(paddingFor(pax.length)));
    }

    const link = entry.source.kind === "symlink" ? entry.source.target : undefined;
    const size = link === undefined ? entry.size : 0;
    await this.write(
      encodeHeader({ name: entry.name, size, mode: entry.mode, mtime: this.mtime, type: link === undefined ? "0" : "2", linkname: link }),
    );
    if (entry.source.kind === "buffer") await this.write(entry.source.data);
    else if (entry.source.kind === "file") {
      for await (const chunk of createReadStream(entry.source.path)) await this.write(chunk as Buffer);
    }
    await this.write(new Uint8Array(paddingFor(size)));
  }

  async close(): Promise<void> {
    await this.write(new Uint8Array(END_BYTES));
    this.out.end();
    await once(this.out, "finish");
  }
}
