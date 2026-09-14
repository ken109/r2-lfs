import type { ReactNode } from "react";

/** Server functions answer with the use cases' results; a failed one carries the status and a message to show. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export const formatCount = (n: number) => new Intl.NumberFormat("en").format(Math.round(n));

export const formatDate = (iso: string) => new Date(iso).toLocaleString();

export function Failure({ message }: { message: string }): ReactNode {
  return (
    <p className="notice error" role="alert">
      {message}
    </p>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {children ? <p className="lede">{children}</p> : null}
    </header>
  );
}

/** The admin UI's styles: one sheet, light and dark. */
export const STYLES = `
:root { color-scheme: light dark; --bg: #f7f7f5; --panel: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e3de;
  --accent: #f38020; --accent-text: #fff; --danger: #c62828; --ok: #2e7d32; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bg: #141413; --panel: #1d1d1b; --text: #ececea; --muted: #9a9a94; --line: #33332f; --danger: #ef6c6c; --ok: #7bc47f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: 15px; line-height: 1.5; }
a { color: inherit; }
.shell { display: grid; grid-template-columns: 200px 1fr; min-height: 100vh; }
.sidebar { border-right: 1px solid var(--line); padding: 20px 16px; display: flex; flex-direction: column; gap: 4px; }
.brand { font-weight: 700; font-size: 17px; margin: 0 8px 16px; }
.brand span { color: var(--accent); }
.nav-link { display: block; padding: 6px 8px; border-radius: 6px; text-decoration: none; color: var(--muted); }
.nav-link:hover { color: var(--text); background: var(--line); }
.nav-link.active { color: var(--text); background: var(--panel); box-shadow: inset 2px 0 0 var(--accent); }
.who { margin-top: auto; font-size: 12px; color: var(--muted); padding: 0 8px; overflow-wrap: anywhere; }
main { padding: 28px 32px 48px; max-width: 1080px; width: 100%; }
.page-header h1 { margin: 0; font-size: 22px; }
.lede { margin: 4px 0 0; color: var(--muted); }
section { margin-top: 28px; }
h2 { font-size: 15px; margin: 0 0 10px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.stat .label { font-size: 12px; color: var(--muted); }
.stat .value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat .sub { font-size: 12px; color: var(--muted); }
dl.settings { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; margin: 0; }
dl.settings dt { color: var(--muted); }
dl.settings dd { margin: 0; }
.table-wrap { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font-size: 12px; font-weight: 600; color: var(--muted); }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.empty { color: var(--muted); padding: 16px; }
form.inline { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
label.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
input, select { font: inherit; height: 36px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; }
input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button { font: inherit; height: 36px; border-radius: 6px; padding: 6px 14px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.danger { color: var(--danger); }
button:disabled { opacity: 0.6; cursor: default; }
.notice { border-radius: 8px; padding: 10px 14px; margin: 12px 0; border: 1px solid var(--line); background: var(--panel); }
.notice.error { border-color: var(--danger); color: var(--danger); }
.notice.warn { border-color: var(--accent); }
.secret { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.secret code { background: var(--bg); padding: 6px 10px; border-radius: 6px; overflow-wrap: anywhere; flex: 1; }
.badge { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
@media (max-width: 720px) { .shell { grid-template-columns: 1fr; } .sidebar { flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--line); }
  .brand { margin: 0 12px 0 0; align-self: center; } .who { display: none; } main { padding: 20px 16px 40px; } }
`;
