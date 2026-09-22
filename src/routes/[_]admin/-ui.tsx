import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { formatDate, formatRelative } from "./-format.ts";

/** Server functions answer with the use cases' results; a failed one carries the status and a message to show. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

export { formatBytes, formatCount, formatDate, formatRelative } from "./-format.ts";

/** Whether the component has hydrated; false during the server render and the hydration that follows it. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/**
 * A point in time: the server renders a fixed UTC form, and the browser switches to a relative one after hydrating,
 * so both renders agree. The exact time stays in the tooltip.
 */
export function Time({ iso, relative = true }: { iso: string; relative?: boolean }): ReactNode {
  const hydrated = useHydrated();
  const exact = formatDate(iso);
  return (
    <time dateTime={iso} title={exact}>
      {relative && hydrated ? formatRelative(iso, Date.now()) : exact}
    </time>
  );
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface Action {
  /** The key of the task that is running, if one is. */
  busy: string | undefined;
  failure: string | undefined;
  /** What the last task that succeeded reported, shown as a toast for a few seconds. */
  done: string | undefined;
  /**
   * Runs `task` unless another task of this page is running, and reports a failed outcome or a thrown error as the
   * failure. `success` names what was done; `after` runs once it succeeded, such as reloading the page's data.
   */
  run<T>(
    key: string,
    task: () => Promise<Outcome<T>>,
    options?: { success?: (value: T) => string | undefined; after?: (value: T) => unknown },
  ): Promise<T | undefined>;
  dismiss(): void;
}

/** Changes a page makes: one at a time, with the failure or a toast that says what happened. */
export function useAction(): Action {
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [done, setDone] = useState<string>();
  // State updates arrive after a render; the ref stops a second click that lands before it.
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  return {
    busy,
    failure,
    done,
    async run(key, task, options = {}) {
      if (running.current) return undefined;
      running.current = true;
      setBusy(key);
      setFailure(undefined);
      try {
        const outcome = await task();
        if (!outcome.ok) {
          setFailure(outcome.message);
          return undefined;
        }
        const message = options.success?.(outcome.value);
        if (message) {
          clearTimeout(timer.current);
          setDone(message);
          timer.current = setTimeout(() => setDone(undefined), 5000);
        }
        await options.after?.(outcome.value);
        return outcome.value;
      } catch (err) {
        setFailure(describe(err));
        return undefined;
      } finally {
        running.current = false;
        setBusy(undefined);
      }
    },
    dismiss() {
      setFailure(undefined);
    },
  };
}

/** Where a page's action reports: its failure in place, and a toast for what succeeded. */
export function ActionStatus({ action }: { action: Action }): ReactNode {
  return (
    <>
      {action.failure ? <Failure message={action.failure} /> : null}
      <div className="toast-region" role="status" aria-live="polite">
        {action.done ? <div className="toast">{action.done}</div> : null}
      </div>
    </>
  );
}

export function Failure({ message }: { message: string }): ReactNode {
  return (
    <p className="notice error" role="alert">
      {message}
    </p>
  );
}

/** A table's caption, for screen readers only: the heading above the table already says it on screen. */
export function Caption({ children }: { children: ReactNode }): ReactNode {
  return <caption className="visually-hidden">{children}</caption>;
}

/**
 * Copies `text`. Where the clipboard is unavailable (an insecure origin, a refused permission), it selects the text
 * of `target` instead and asks to copy it by hand.
 */
export function CopyButton({ text, target }: { text: string; target: () => HTMLElement | null }): ReactNode {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 2000);
    } catch {
      const element = target();
      if (element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setState("manual");
    }
  }

  return (
    <>
      <button type="button" onClick={copy}>
        {state === "copied" ? "Copied" : "Copy"}
      </button>
      <span role="status" className={state === "manual" ? "hint" : "visually-hidden"}>
        {state === "copied" ? "Copied to the clipboard" : state === "manual" ? "Selected: press Ctrl+C or ⌘C to copy" : ""}
      </span>
    </>
  );
}

/** What a page shows when loading it threw, such as a lost connection or a Worker error. */
export function RouteError({ error, reset }: ErrorComponentProps): ReactNode {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    setRetrying(true);
    try {
      reset();
      await router.invalidate();
    } finally {
      setRetrying(false);
    }
  }
  return (
    <>
      <PageHeader title="This page did not load" />
      <Failure message={describe(error)} />
      <button type="button" className="primary" onClick={retry} disabled={retrying}>
        {retrying ? "Retrying…" : "Try again"}
      </button>
    </>
  );
}

export function RoutePending(): ReactNode {
  return (
    <p className="pending" role="status">
      Loading…
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
  --accent: #b34d00; --accent-text: #fff; --danger: #c62828; --ok: #2e7d32; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bg: #141413; --panel: #1d1d1b; --text: #ececea; --muted: #9a9a94; --line: #33332f;
  --accent: #f38020; --accent-text: #141413; --danger: #ef6c6c; --ok: #7bc47f; } }
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
button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.danger { color: var(--danger); }
button:disabled { opacity: 0.6; cursor: default; }
.notice { border-radius: 8px; padding: 10px 14px; margin: 12px 0; border: 1px solid var(--line); background: var(--panel); }
.notice.error { border-color: var(--danger); color: var(--danger); }
.notice.warn { border-color: var(--accent); }
.secret { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.secret code { background: var(--bg); padding: 6px 10px; border-radius: 6px; overflow-wrap: anywhere; flex: 1; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.hint { font-size: 12px; color: var(--muted); }
.toast-region { position: fixed; right: 20px; bottom: 20px; z-index: 10; }
.toast { background: var(--text); color: var(--bg); border-radius: 8px; padding: 10px 14px; box-shadow: 0 4px 16px rgb(0 0 0 / 0.2); max-width: 360px; }
.pending { color: var(--muted); padding: 28px 32px; }
.badge { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
@media (max-width: 720px) { .shell { grid-template-columns: 1fr; } .sidebar { flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--line); }
  .brand { margin: 0 12px 0 0; align-self: center; } .who { display: none; } main { padding: 20px 16px 40px; } }
`;
