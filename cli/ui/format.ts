import { styleText } from "node:util";

type Style = Parameters<typeof styleText>[0];
// styleText honours NO_COLOR, FORCE_COLOR and whether stdout is a terminal.
const style = (format: Style) => (text: string) => styleText(format, text, { stream: process.stdout });
export const bold = style("bold");
export const dim = style("dim");
export const red = style("red");
export const yellow = style("yellow");
export const cyan = style("cyan");

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function shortOid(oid: string): string {
  return oid.slice(0, 10);
}

// oxlint-disable-next-line no-control-regex -- matching ANSI escape sequences is the point.
const ANSI = /\x1b\[[0-9;]*m/g;

function isWide(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x1f300)
  );
}

/** Terminal columns a string occupies; CJK file names take two per character. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text.replace(ANSI, "")) width += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return width;
}

/** Aligned columns. `align` has one character per column: "r" right-aligns it. */
export function table(headers: string[], rows: string[][], align = ""): string {
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ""))));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => {
        const pad = " ".repeat(widths[i]! - displayWidth(cell));
        return align[i] === "r" ? pad + cell : cell + pad;
      })
      .join("  ")
      .trimEnd();
  return [bold(line(headers)), ...rows.map(line)].join("\n");
}
