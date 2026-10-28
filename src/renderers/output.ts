import { EXIT_CODES, toErrorObject, type ErrorObject } from "../errors.ts";
import { escapeText } from "./escape.ts";

export type Status = "ok" | "partial" | "error";

export interface Envelope<T> {
  schemaVersion: 1;
  command: string;
  status: Status;
  data: T | null;
  warnings: string[];
  errors: ErrorObject[];
}

export interface CommandResult<T> {
  data: T;
  warnings?: string[];
  errors?: ErrorObject[];
  status?: Status;
  text: (data: T) => string[];
}

export interface OutputOptions {
  json: boolean;
  color: boolean;
}

export function exitCodeFor(errors: ErrorObject[]): number {
  return errors.length === 0 ? 0 : EXIT_CODES[errors[0]!.code];
}

export function emitResult<T>(command: string, result: CommandResult<T>, opts: OutputOptions): number {
  const warnings = result.warnings ?? [];
  const errors = result.errors ?? [];
  const status: Status = result.status ?? (errors.length ? "partial" : "ok");
  if (opts.json) {
    const envelope: Envelope<T> = { schemaVersion: 1, command, status, data: result.data, warnings, errors };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  } else {
    // Text renderers escape untrusted values themselves; warnings are escaped here.
    process.stdout.write(result.text(result.data).join("\n") + "\n");
    for (const w of warnings) process.stderr.write(`Warning: ${escapeText(w)}\n`);
    for (const e of errors) process.stderr.write(`Error [${e.code}]: ${escapeText(e.message)}\n  Next: ${e.nextAction}\n`);
  }
  return exitCodeFor(errors);
}

export function emitError(command: string, err: unknown, opts: OutputOptions): number {
  const error = toErrorObject(err);
  if (opts.json) {
    const envelope: Envelope<null> = { schemaVersion: 1, command, status: "error", data: null, warnings: [], errors: [error] };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  } else {
    process.stderr.write(`Error [${error.code}]: ${escapeText(error.message)}\n  Next: ${error.nextAction}\n`);
  }
  return EXIT_CODES[error.code];
}
