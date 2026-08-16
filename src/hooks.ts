import { stat } from "node:fs/promises";
import type { CopyOptions, CopyResult } from "./types";

//----- default hook implementations. Exported so a custom hook can call
// through to (and build on top of) the default behavior. Prefixed with
// `default` so they don't read as though they were the `CopyOptions`
// fields themselves.

export async function defaultOnCheckChanged(
  srcFile: string,
  destFile: string,
  _options: Required<CopyOptions>,
): Promise<boolean> {
  try {
    const [destStat, srcStat] = await Promise.all([stat(destFile), stat(srcFile)]);
    const isTimeChanged = srcStat.mtimeMs > destStat.mtimeMs;
    const isSizeChanged = srcStat.size !== destStat.size;
    return isTimeChanged || isSizeChanged;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return true; // dest file does not exist.
    }
    throw error;
  }
}

export function defaultOnClearDest(delPatterns: string[], options: Required<CopyOptions>): void {
  // Used for both "emptied a dest directory" and "removed a single dest
  // file" - the patterns themselves (a glob list vs. one absolute path)
  // already convey which case it was, so the message stays generic.
  if (options.logLevel === "verbose") options.logger.warn(`cleaned: '${delPatterns.join(",")}'.`);
}

export function defaultOnCopy(
  srcFile: string,
  destFile: string,
  options: Required<CopyOptions>,
): void {
  if (options.logLevel === "verbose") options.logger.info(`Copy: ${srcFile} -> ${destFile}`);
}

export function defaultOnSkip(
  srcFile: string,
  destFile: string,
  options: Required<CopyOptions>,
): void {
  if (options.logLevel === "verbose") options.logger.info(`Skip: ${srcFile} -> ${destFile}`);
}

export function defaultOnFinish(result: CopyResult, options: Required<CopyOptions>): void {
  if (options.logLevel !== "silent") {
    options.logger.info(`${result.copyCount} file(s) copied, ${result.skipCount} file(s) skipped.`);
  }
}
