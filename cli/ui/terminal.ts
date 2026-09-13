import * as clack from "@clack/prompts";

import type { Progress, Reporter } from "../app/ports.ts";
import { UsageError } from "../domain/errors.ts";
import { bold } from "./format.ts";

/**
 * Human-oriented output. With `--json` a command creates a quiet terminal,
 * so stdout carries only the JSON document.
 */
export class Terminal implements Reporter {
  readonly quiet: boolean;

  constructor(opts: { quiet?: boolean } = {}) {
    this.quiet = Boolean(opts.quiet);
  }

  get interactive(): boolean {
    return !this.quiet && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  /** Spinners and progress bars redraw lines, which only makes sense on a terminal (not in CI logs). */
  private get animated(): boolean {
    return !this.quiet && Boolean(process.stdout.isTTY);
  }

  intro(title: string): void {
    if (!this.quiet) clack.intro(bold(title));
  }

  outro(message: string): void {
    if (!this.quiet) clack.outro(message);
  }

  note(message: string, title?: string): void {
    if (!this.quiet) clack.note(message, title);
  }

  message(text: string): void {
    if (!this.quiet) clack.log.message(text);
  }

  step(message: string): void {
    if (!this.quiet) clack.log.step(message);
  }

  info(message: string): void {
    if (!this.quiet) clack.log.info(message);
  }

  warn(message: string): void {
    if (!this.quiet) clack.log.warn(message);
  }

  error(message: string): void {
    if (!this.quiet) clack.log.error(message);
  }

  success(message: string): void {
    if (!this.quiet) clack.log.success(message);
  }

  json(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  async task<T>(label: string, work: () => T | Promise<T>, done?: (result: T) => string): Promise<T> {
    if (this.quiet) return work();
    if (!this.animated) {
      const result = await work();
      clack.log.step(done ? done(result) : label);
      return result;
    }
    const spin = clack.spinner();
    spin.start(label);
    try {
      const result = await work();
      spin.stop(done ? done(result) : label);
      return result;
    } catch (err) {
      spin.error(label);
      throw err;
    }
  }

  progress(total: number, label: string): Progress {
    if (this.quiet || total === 0) return { advance: () => {}, stop: () => {} };
    if (!this.animated) return { advance: () => {}, stop: (message) => clack.log.step(message ?? label) };
    const bar = clack.progress({ max: total });
    bar.start(label);
    return { advance: (count = 1, message) => bar.advance(count, message), stop: (message) => bar.stop(message ?? label) };
  }

  private settle<T>(value: T | symbol): T {
    if (clack.isCancel(value)) {
      clack.cancel("Cancelled");
      process.exit(130);
    }
    return value as T;
  }

  private requireInteractive(what: string): void {
    if (!this.interactive) throw new UsageError(`${what}; pass it as an option when not running in a terminal`);
  }

  async confirm(message: string, initialValue = false): Promise<boolean> {
    if (!this.interactive) return initialValue;
    return this.settle(await clack.confirm({ message, initialValue }));
  }

  async text(message: string, opts: { placeholder?: string; validate?: (value: string) => string | undefined } = {}): Promise<string> {
    this.requireInteractive(message);
    return this.settle(await clack.text({ message, placeholder: opts.placeholder, validate: (v) => opts.validate?.(v ?? "") }));
  }

  async select<T extends string>(message: string, options: { value: T; label: string; hint?: string }[], initialValue?: T): Promise<T> {
    this.requireInteractive(message);
    return this.settle(await clack.select({ message, options: options as clack.Option<T>[], initialValue }));
  }

  async multiselect<T>(message: string, options: { value: T; label: string; hint?: string }[], initialValues: T[] = []): Promise<T[]> {
    this.requireInteractive(message);
    return this.settle(
      await clack.autocompleteMultiselect({ message, options: options as clack.Option<T>[], initialValues, required: false }),
    );
  }
}
