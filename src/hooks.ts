import { stat } from "node:fs/promises";
import chalk from "chalk";
import type { CopyOptions, CopyResult } from "./types";

//----- default hook implementations. Exported so a custom hook can call
// through to (and build on top of) the default behavior. Prefixed with
// `default` so they don't read as though they were the `CopyOptions`
// fields themselves.

const headerInfo = chalk.green("[copy-changed]");
const headerWarn = chalk.red("[copy-changed]");

export async function defaultOnCheckChanged(
  srcFile: string,
  destFile: string,
  _options: CopyOptions,
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

export function defaultOnClearDest(delPatterns: string[], options: CopyOptions): void {
  // Used for both "emptied a dest directory" and "removed a single dest
  // file" - the patterns themselves (a glob list vs. one absolute path)
  // already convey which case it was, so the message stays generic.
  if (options.logLevel === "verbose")
    console.log(`${headerWarn} cleaned: '${delPatterns.join(",")}'.`);
}

export function defaultOnCopy(srcFile: string, destFile: string, options: CopyOptions): void {
  if (options.logLevel === "verbose") console.log(`${headerInfo}: Copy: ${srcFile} -> ${destFile}`);
}

export function defaultOnSkip(srcFile: string, destFile: string, options: CopyOptions): void {
  if (options.logLevel === "verbose") console.log(`${headerInfo}: Skip: ${srcFile} -> ${destFile}`);
}

export function defaultOnFinish(result: CopyResult, options: CopyOptions): void {
  if (options.logLevel !== "silent") {
    console.log(
      `${headerInfo}: ${result.copyCount} file(s) copied, ${result.skipCount} file(s) skipped.`,
    );
  }
}
