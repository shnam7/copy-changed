import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { deleteAsync } from "del";
import globParent from "glob-parent";
import { glob, isDynamicPattern } from "tinyglobby";

const headerInfo = chalk.green("[copy-changed]");
const headerWarn = chalk.red("[copy-changed]");

export interface CopyParam {
  src: string | readonly string[];
  dest: string;
  options?: CopyOptions;
}

export interface CopyOptions {
  // current working directory. Only used to resolve relative `src`/`dest`
  // paths - never mutates the actual process cwd, so concurrent calls
  // (e.g. via Promise.all) are safe.
  cwd?: string;

  /*
    If true, empty whole dest.
    If glob, delete matched files only within the dest folder. (using del module).
    The glob should be relative path from the dest.
    Ignored (with a verbose warning) when dest resolves to a single file.
  */
  clearDest?: boolean | string | readonly string[];

  // overwrite the destination. default is false.
  force?: boolean;

  logLevel?: "normal" | "verbose" | "silent";
}

export interface CopyResult {
  copyCount: number;
  skipCount: number;
}

const arrayify = <T>(value: T | readonly T[]): T[] =>
  Array.isArray(value) ? [...value] : [value as T];

const isCopyParam = (value: unknown): value is CopyParam =>
  typeof value === "object" && value !== null && !Array.isArray(value) && "src" in value;

/**
 * Check whether pathName is a directory.
 *  - If pathName exists on disk, returns whether it's a directory.
 *  - If it doesn't exist, guesses based on a trailing '/' or a missing
 *    extension (e.g. 'dest/' or 'dest' -> directory, 'dest.txt' -> file).
 *    Note: this heuristic can misclassify intentionally extension-less
 *    files such as '.env', 'Makefile', or 'LICENSE' as directories.
 *
 * @param pathName Absolute path to check.
 */
const isDirectory = async (pathName: string): Promise<boolean> => {
  try {
    const stats = await stat(pathName);
    return stats.isDirectory();
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return pathName.endsWith(path.sep) || path.extname(pathName).length === 0;
    }
    throw error;
  }
};

/**
 * Copy changed files to destination directory.
 * File change is determined by comparing modified time and size.
 *
 * Note:
 *  If dest is a file, then src should also be a single file, not a glob.
 *  If src is an array of globs, then the globBase is derived from the
 *  first one, src[0].
 *
 * @param src Source pattern(s), a glob string or an array of glob strings (input to tinyglobby)
 * @param dest Destination directory or a file.
 * @param options CopyOptions
 */
export async function copyChanged(
  src: string | readonly string[],
  dest: string,
  options?: CopyOptions,
): Promise<CopyResult>;

/**
 * Copy changed files to destination directory.
 * File change is determined by comparing modified time and size.
 *
 * @param params Single CopyParam or an array of CopyParam's.
 */
export async function copyChanged(params: CopyParam | readonly CopyParam[]): Promise<CopyResult>;

/**
 * copyChanged implementation.
 */
export async function copyChanged(
  arg1: string | readonly string[] | CopyParam | readonly CopyParam[],
  dest?: string,
  options: CopyOptions = {},
): Promise<CopyResult> {
  const result: CopyResult = { copyCount: 0, skipCount: 0 };

  // Single CopyParam object.
  if (isCopyParam(arg1)) {
    return copyChanged(arg1.src, arg1.dest, arg1.options);
  }

  // Array of CopyParam objects.
  if (Array.isArray(arg1) && (arg1.length === 0 || isCopyParam(arg1[0]))) {
    for (const param of arg1 as readonly CopyParam[]) {
      const r = await copyChanged(param);
      result.copyCount += r.copyCount;
      result.skipCount += r.skipCount;
    }
    return result;
  }

  // Here, arg1 is a non-empty glob string or array of glob strings (an empty
  // array was already absorbed by the CopyParam[] branch above), and dest is
  // defined. Validating individual pattern strings (e.g. an empty string) is
  // left to tinyglobby/glob-parent, which already handle that gracefully.
  const srcPatterns = arrayify(arg1 as string | readonly string[]);

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const destAbs = path.resolve(cwd, dest as string);
  const isDestDirectory = await isDirectory(destAbs);
  const destBase = isDestDirectory ? destAbs : path.dirname(destAbs);

  // Single-file copy: src must resolve to exactly one, non-glob file.
  let isSingleFileCopy = false;
  if (!isDestDirectory) {
    if (srcPatterns.length > 1 || isDynamicPattern(srcPatterns[0] as string)) {
      throw Error(
        `Glob pattern cannot be copied to file: '${JSON.stringify(arg1)}' -> dest='${destAbs}'.`,
      );
    }
    isSingleFileCopy = true;
  }

  // Handle clearDest option.
  if (options.clearDest) {
    if (isDestDirectory) {
      const clearDest = options.clearDest === true ? ["*"] : arrayify(options.clearDest);
      const delPatterns = clearDest.map((pattern) =>
        pattern.startsWith("!")
          ? `!${path.join(destBase, pattern.slice(1))}`
          : path.join(destBase, pattern),
      );

      await deleteAsync(delPatterns, { cwd: destBase });
      if (options.logLevel === "verbose")
        console.log(`${headerWarn} target directory cleaned: '${delPatterns.join(",")}'.`);
    } else if (options.logLevel === "verbose") {
      console.log(`${headerWarn} clearDest ignored: dest '${destAbs}' is a single file.`);
    }
  }

  const files = await glob([...srcPatterns], { cwd });
  const globBase = path.resolve(cwd, globParent(srcPatterns[0] as string, {}));

  for await (const file of files) {
    const srcFile = path.resolve(cwd, file);
    const variablePath = path.relative(globBase, srcFile);
    const destFile = isSingleFileCopy ? destAbs : path.join(destBase, variablePath);
    const destDir = path.dirname(destFile);

    let isChanged = options.force === true;

    if (!isChanged) {
      try {
        const [destStat, srcStat] = await Promise.all([stat(destFile), stat(srcFile)]);
        const isTimeChanged = srcStat.mtimeMs > destStat.mtimeMs;
        const isSizeChanged = srcStat.size !== destStat.size;
        isChanged = isTimeChanged || isSizeChanged;
      } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          isChanged = true; // dest file does not exist.
        } else {
          throw error;
        }
      }
    }

    if (isChanged) {
      await mkdir(destDir, { recursive: true });
      await copyFile(srcFile, destFile);
      result.copyCount++;
      if (options.logLevel === "verbose") console.log(`[copy-changed] ${srcFile} -> ${destFile}`);
    } else {
      result.skipCount++;
      if (options.logLevel === "verbose") console.log(`[SKIP] ${srcFile} -> ${destFile}`);
    }
  }

  if (options.logLevel !== "silent") {
    console.log(
      `${headerInfo}: ${result.copyCount} file(s) copied, ${result.skipCount} file(s) skipped.`,
    );
  }

  return result;
}
