import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getDefaultLogger } from "@wicle/tiny-logger";
import { deleteAsync } from "del";
import globParent from "glob-parent";
import { glob, isDynamicPattern } from "tinyglobby";
import {
  defaultOnCheckChangedAsync,
  defaultOnClearDest,
  defaultOnCopy,
  defaultOnFinish,
  defaultOnSkip,
} from "./hooks";
import type { CopyOptions, CopyParam, CopyResult } from "./types";
import { arrayify, isCopyParam, isDirectory, resolveGlobBase } from "./utils";

export type { CopyOptions, CopyParam, CopyResult };
export {
  defaultOnCheckChangedAsync,
  defaultOnClearDest,
  defaultOnCopy,
  defaultOnFinish,
  defaultOnSkip,
};

/**
 * Copy changed files to destination directory (async).
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
export async function copyChangedAsync(
  src: string | readonly string[],
  dest: string,
  options?: CopyOptions,
): Promise<CopyResult>;

/**
 * Copy changed files to destination directory (async).
 * File change is determined by comparing modified time and size.
 *
 * @param params Single CopyParam or an array of CopyParam's.
 */
export async function copyChangedAsync(
  params: CopyParam | readonly CopyParam[],
  defaultOptions?: CopyOptions,
): Promise<CopyResult>;

/**
 * copyChanged implementation.
 */
export async function copyChangedAsync(
  arg1: string | readonly string[] | CopyParam | readonly CopyParam[],
  arg2?: string | CopyOptions,
  options: CopyOptions = {},
): Promise<CopyResult> {
  const result: CopyResult = { copyCount: 0, skipCount: 0 };

  // Single CopyParam object.
  if (isCopyParam(arg1)) {
    const defaultOptions = arg2 as CopyOptions;
    return copyChangedAsync(arg1.src, arg1.dest, { ...defaultOptions, ...arg1.options });
  }

  // Array of CopyParam objects.
  if (Array.isArray(arg1)) {
    if (arg1.length === 0) {
      // No elements to inspect, so `arg2` is the only signal for which
      // overload was actually called. Only a *string* `arg2` means the
      // srcPatterns overload's `dest` was actually given - `undefined` or
      // a CopyOptions object both mean the CopyParam[] overload (with
      // zero params, optionally with defaultOptions), a pure no-op.
      if (typeof arg2 !== "string") return result;
    } else if (isCopyParam(arg1[0])) {
      const defaultOptions = arg2 as CopyOptions;
      for (const param of arg1 as readonly CopyParam[]) {
        const r = await copyChangedAsync(param, defaultOptions);
        result.copyCount += r.copyCount;
        result.skipCount += r.skipCount;
      }
      return result;
    }
  }

  const opts: Required<CopyOptions> = {
    cwd: process.cwd(),
    clearDest: false,
    force: false,
    logLevel: "info",
    globOptions: {},
    dryRun: false,
    onCheckChanged: defaultOnCheckChangedAsync,
    onClearDest: defaultOnClearDest,
    onCopy: defaultOnCopy,
    onSkip: defaultOnSkip,
    onFinish: defaultOnFinish,
    ...options,

    // override the logger
    logger: options.logger ?? getDefaultLogger(),
  };

  // Only touch the logger's level when the caller explicitly passed
  // `logLevel` - otherwise leave a caller-supplied logger's own level (or
  // the shared default logger's "info" level) untouched, and reflect the
  // logger's actual level back onto `opts.logLevel` for consistency.
  if (options.logLevel) {
    opts.logger.level = options.logLevel;
  } else {
    opts.logLevel = opts.logger.level;
  }

  const srcPatterns = arrayify(arg1 as string | readonly string[]);
  const cwd = path.resolve(opts.cwd);
  const destAbs = path.resolve(cwd, arg2 as string);
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

      if (!opts.dryRun) await deleteAsync(delPatterns, { cwd: destBase });
      await opts.onClearDest(delPatterns, opts);
    } else {
      if (!opts.dryRun) await deleteAsync(destAbs, { cwd: destBase });
      await opts.onClearDest([destAbs], opts);
    }
  }

  const files = await glob([...srcPatterns], { ...opts.globOptions, cwd });
  const globBase = resolveGlobBase(
    srcPatterns.map((pattern) => {
      // globParent expects POSIX style slash(/).
      const normalizedPattern = pattern.replace(/\\/g, "/");
      const parent = globParent(normalizedPattern, {});
      return path.resolve(cwd, parent);
    }),
    cwd,
  );

  for (const file of files) {
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

export { copyChangedAsync as copyChanged };
