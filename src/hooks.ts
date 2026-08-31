import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { LogLevel } from "@wicle/tiny-logger";
import { LOG_LEVEL } from "@wicle/tiny-logger";
import type { CopyOptions, CopyResult } from "./types";

// Whether a message at `messageLevel` should actually be logged given the
// caller's configured `configuredLevel`. This is copy-changed's own
// contract, independent of whatever logger is plugged in - a logger like
// the shared @wicle/tiny-logger default also filters by its own `.level`
// (see copyChangedAsync.ts/copyChangedSync.ts, which forward `logLevel`
// onto `logger.level`), but that only works for loggers that actually
// implement level-based filtering. Plain `console`, the mock loggers in
// this project's tests, and many other minimal ts-log-compatible loggers
// do not - `logger.level = "silent"` is a no-op property assignment for
// them, so without this check `logger.info(...)` would still fire. This
// check makes `logLevel` behave identically for every logger.
function shouldLog(configuredLevel: LogLevel, messageLevel: keyof typeof LOG_LEVEL): boolean {
  if (configuredLevel === "silent") return false;
  return LOG_LEVEL[messageLevel] >= LOG_LEVEL[configuredLevel];
}

//----- onCheckChanged: the one hook with genuinely different I/O between
// the async and sync variants (stat vs statSync), so each keeps its own
// body. Both treat a missing dest file (ENOENT) as "changed" - a fresh
// copy into a brand-new destination is the most common case, and it must
// not throw.

export async function defaultOnCheckChangedAsync(
  srcFile: string,
  destFile: string,
  _options: Required<CopyOptions>,
): Promise<boolean> {
  const srcStat = await stat(srcFile);

  try {
    const destStat = await stat(destFile);
    return srcStat.size !== destStat.size || srcStat.mtimeMs > destStat.mtimeMs;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return true; // dest file does not exist.
    }
    throw error;
  }
}

export function defaultOnCheckChanged(
  srcFile: string,
  destFile: string,
  _options: Required<CopyOptions>,
): boolean {
  const srcStat = statSync(srcFile);

  try {
    const destStat = statSync(destFile);
    return srcStat.size !== destStat.size || srcStat.mtimeMs > destStat.mtimeMs;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return true; // dest file does not exist.
    }
    throw error;
  }
}

//----- The remaining four hooks do no I/O at all (just conditional
// logging), so there's only one implementation for both APIs - not a
// "sync version" that async happens to reuse, just the only version.
// Typed against Required<CopyOptions>, matching the hook signatures
// declared in types.ts, so a custom hook has the same full options
// object available that these defaults do (even though these only use
// logLevel/logger). copyChangedAsync awaits every hook call, so a plain
// sync function here works fine as its default too.

export function defaultOnClearDest(delPatterns: string[], options: Required<CopyOptions>): void {
  if (shouldLog(options.logLevel, "verbose")) {
    options.logger.verbose(`cleaned: '${delPatterns.join(",")}'.`);
  }
}

export function defaultOnCopy(
  srcFile: string,
  destFile: string,
  options: Required<CopyOptions>,
): void {
  if (shouldLog(options.logLevel, "verbose")) {
    options.logger.verbose(`Copy: ${srcFile} -> ${destFile}`);
  }
}

export function defaultOnSkip(
  srcFile: string,
  destFile: string,
  options: Required<CopyOptions>,
): void {
  if (shouldLog(options.logLevel, "verbose")) {
    options.logger.verbose(`Skip: ${srcFile} -> ${destFile}`);
  }
}

export function defaultOnFinish(result: CopyResult, options: Required<CopyOptions>): void {
  if (shouldLog(options.logLevel, "info")) {
    options.logger.info(`${result.copyCount} file(s) copied, ${result.skipCount} file(s) skipped.`);
  }
}
