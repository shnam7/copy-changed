import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
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
import {
  arrayify,
  createLogger,
  getDefaultLogger,
  isCopyParam,
  isDirectory,
  resolveGlobBase,
} from "./utils";

export type { CopyOptions, CopyParam, CopyResult };
export {
  createLogger,
  defaultOnCheckChanged,
  defaultOnClearDest,
  defaultOnCopy,
  defaultOnFinish,
  defaultOnSkip,
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
    logger: getDefaultLogger(),
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
