import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { CopyOptions, CopyResult } from "./types";

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
  try {
    const [destStat, srcStat] = await Promise.all([stat(destFile), stat(srcFile)]);
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
  try {
    const destStat = statSync(destFile);
    const srcStat = statSync(srcFile);
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
  options.logger.verbose(`cleaned: '${delPatterns.join(",")}'.`);
}

export function defaultOnCopy(
  srcFile: string,
  destFile: string,
  options: Required<CopyOptions>,
): void {
  options.logger.verbose(`Copy: ${srcFile} -> ${destFile}`);
}

export function defaultOnSkip(
  srcFile: string,
  destFile: string,
  options: Required<CopyOptions>,
): void {
  options.logger.verbose(`Skip: ${srcFile} -> ${destFile}`);
}

export function defaultOnFinish(result: CopyResult, options: Required<CopyOptions>): void {
  options.logger.info(`${result.copyCount} file(s) copied, ${result.skipCount} file(s) skipped.`);
}
