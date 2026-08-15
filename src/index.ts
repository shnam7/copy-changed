import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import commonPathPrefix from "common-path-prefix";
import { deleteAsync } from "del";
import globParent from "glob-parent";
import { glob, isDynamicPattern } from "tinyglobby";
import {
  defaultOnCheckChanged,
  defaultOnClearDest,
  defaultOnCopy,
  defaultOnFinish,
  defaultOnSkip,
} from "./hooks";
import type { CopyOptions, CopyParam, CopyResult } from "./types";

export type { CopyOptions, CopyParam, CopyResult };
export { defaultOnCheckChanged, defaultOnClearDest, defaultOnCopy, defaultOnFinish, defaultOnSkip };

//----- Internal functions -----
const arrayify = <T>(value: T | readonly T[]): T[] =>
  Array.isArray(value) ? [...value] : [value as T];

const isCopyParam = (value: unknown): value is CopyParam =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "src" in value &&
  "dest" in value;

const stripTrailingSep = (p: string): string => (p.endsWith(path.sep) ? p.slice(0, -1) : p);

/**
 * Resolves the base directory that matched files' relative paths are
 * computed against, given one or more absolute glob-parent directories.
 *  - A single (or repeated) parent is used as-is.
 *  - Multiple distinct parents fall back to their longest common ancestor
 *    directory, so patterns pointing at sibling subdirectories (e.g.
 *    'dirA/*.txt' and 'dirB/*.txt') still preserve their relative
 *    structure under dest. If the parents share no ancestor besides the
 *    filesystem root, `cwd` is used instead.
 */
const resolveGlobBase = (parents: string[], cwd: string): string => {
  const uniqueParents = [...new Set(parents)];
  if (uniqueParents.length === 1) return uniqueParents[0] as string;

  const prefix = stripTrailingSep(commonPathPrefix(uniqueParents));
  return prefix || cwd;
};

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
 *  If src is an array of globs, the base directory used to preserve each
 *  matched file's relative path is the longest common ancestor directory
 *  of all the patterns' glob-parents (falling back to cwd if they share
 *  none besides the filesystem root).
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
  const opts: Required<CopyOptions> = {
    cwd: process.cwd(),
    clearDest: false,
    force: false,
    logLevel: "normal",
    globOptions: {},
    dryRun: false,
    onCheckChanged: defaultOnCheckChanged,
    onClearDest: defaultOnClearDest,
    onCopy: defaultOnCopy,
    onSkip: defaultOnSkip,
    onFinish: defaultOnFinish,
    ...options,
  };

  const srcPatterns = arrayify(arg1 as string | readonly string[]);
  const cwd = path.resolve(opts.cwd);
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
  if (opts.clearDest) {
    if (isDestDirectory) {
      const clearDest = opts.clearDest === true ? ["*"] : arrayify(opts.clearDest);
      const delPatterns = clearDest.map((pattern) => {
        const isNegated = pattern.startsWith("!");
        const cleanPattern = isNegated ? pattern.slice(1) : pattern;
        const fullPath = path.join(destBase, cleanPattern).replace(/\\/g, "/");
        return isNegated ? `!${fullPath}` : fullPath;
      });
      // const delPatterns = clearDest.map((pattern) =>
      //   pattern.startsWith("!")
      //     ? `!${path.join(destBase, pattern.slice(1))}`
      //     : path.join(destBase, pattern),
      // );

      if (!opts.dryRun) await deleteAsync(delPatterns, { cwd: destBase });
      await opts.onClearDest(delPatterns, opts);
    } else {
      if (!opts.dryRun) await deleteAsync(destAbs, { cwd: destBase });
      await opts.onClearDest([destAbs], opts);
    }
  }

  const files = await glob([...srcPatterns], { ...opts.globOptions, cwd });
  const globBase = resolveGlobBase(
    // srcPatterns.map((pattern) => path.resolve(cwd, globParent(pattern, {}))),
    srcPatterns.map((pattern) => {
      // globParent expects POSIX style slash(/).
      const normalizedPattern = pattern.replace(/\\/g, "/");
      const parent = globParent(normalizedPattern, {});
      return path.resolve(cwd, parent);
    }),
    cwd,
  );

  for await (const file of files) {
    const srcFile = path.resolve(cwd, file);
    const variablePath = path.relative(globBase, srcFile);
    const destFile = isSingleFileCopy ? destAbs : path.join(destBase, variablePath);
    const destDir = path.dirname(destFile);

    if (opts.force || (await opts.onCheckChanged(srcFile, destFile, opts))) {
      if (!opts.dryRun) {
        await mkdir(destDir, { recursive: true });
        await copyFile(srcFile, destFile);
      }
      result.copyCount++;
      await opts.onCopy(srcFile, destFile, opts);
    } else {
      result.skipCount++;
      await opts.onSkip(srcFile, destFile, opts);
    }
  }

  await opts.onFinish(result, opts);
  return result;
}
