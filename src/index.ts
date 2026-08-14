import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { arrayify, isArray, isString } from "@wicle/is";
import chalk from "chalk";
import { deleteSync } from "del";
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
  // current working directory.
  cwd?: string;

  /*
    If true, empty whole dest.
    If glob, delete matched files only within the dest folder. (using del module).
    The glob should be relative path from the dest.
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

/**
 * Check if the pathName is directoyr or not.
 *  - If pathName exists as directory in the file system, returns true.
 *  - if pathName ends with '/' or does not have extension, then returns true.
 *  - returns false in other cases.
 *
 * @param pathName Path name to check
 * @returns
 */
const isDirectory = async (pathName: string): Promise<boolean> => {
  try {
    const stats = await stat(pathName);
    return stats.isDirectory();
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return pathName.endsWith("/") || path.extname(pathName).length === 0; // ex) 'dest/' is dir, dest is file.
    }
    throw error;
  }
};

/**
 * Copy changed files to destination directory.
 * File change is determined by comparing modified time and size.
 *
 * Note:
 *  If dest is file, then src should also be single file, not a glob.
 *  If src is an array of globs, then the globBase will be from the first one, src[0].
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
 * Note:
 *  If dest is file, then src should also be single file, not a glob.
 *  If src is an array of globs, then the globBase will be from the first one, src[0].
 *
 * @param params Single CopyParam or an array of CopyParam's.
 */
export async function copyChanged(params: CopyParam | readonly CopyParam[]): Promise<CopyResult>;

/**
 * copyChanged Implementation
 */
export async function copyChanged(
  arg1: string | readonly string[] | CopyParam | readonly CopyParam[],
  dest?: string,
  options: CopyOptions = {},
): Promise<CopyResult> {
  const result = { copyCount: 0, skipCount: 0 };
  if (!isString(arg1)) {
    // check if str is string
    if (Object.hasOwn(arg1, "src")) {
      // check if arg1 is CopyParam
      const param = arg1 as CopyParam;
      return copyChanged(param.src, param.dest, param.options);
    }

    // check if arg1 is CopyParam[]
    if (isArray(arg1)) {
      if ((arg1 as []).length === 0) return result;
      if (Object.hasOwn(arg1[0] as CopyParam, "src")) {
        for (const param of arg1 as CopyParam[]) {
          const r = await copyChanged(param);
          result.copyCount += r.copyCount;
          result.skipCount += r.skipCount;
        }
        return result;
      }
    }
  }

  // here, src is string or string[] which is for glob param to tinyglobby.

  const cwdSave = process.cwd();
  if (options.cwd) process.chdir(options.cwd);
  const cwd = process.cwd();

  const srcPatterns = arrayify(arrayify(arg1) as string[]).map((pattern) =>
    path.relative(cwd, path.resolve(cwd, pattern)),
  );
  if (srcPatterns.length === 0 || !srcPatterns[0]) return result;

  dest = path.relative(cwd, path.resolve(cwd, dest as string));
  const isDestDirectory = await isDirectory(dest);
  const destBase = isDestDirectory ? dest : path.dirname(dest);

  // check for Single Copy.
  // src should be a single file when the dest is a file, not a directory.
  let isSingFileCopy = false;
  if (!isDestDirectory) {
    if (srcPatterns.length > 1 || isDynamicPattern(srcPatterns[0] as string)) {
      process.chdir(cwdSave);
      throw Error(`Glob pattern cannot be copied to file: '${arg1}' -> dest='${dest}'.`);
    }
    isSingFileCopy = true;
  }

  // Handle clearDest option
  if (options.clearDest && isDestDirectory) {
    const clearDest = options.clearDest === true ? ["*"] : arrayify(options.clearDest);
    const delPatterns = arrayify(clearDest).map((pattern) => {
      return pattern.startsWith("!")
        ? `!${path.join(destBase, pattern.slice(1))}`
        : path.join(destBase, pattern);
    });

    deleteSync(delPatterns);
    if (options.logLevel === "verbose")
      console.log(`${headerWarn} target directory cleaned: '${delPatterns.join(",")}'.`);
  }

  const files = await glob(srcPatterns);
  const globBase = globParent(srcPatterns[0] as string); // take first one of the glob list.

  for await (const file of files) {
    const srcFile = path.relative(cwd, file); // relative path of file
    const variablePath = path.relative(globBase, srcFile);

    let destDir = path.join(destBase, path.dirname(variablePath));
    const destFile = isDestDirectory ? path.join(destBase, variablePath) : dest;

    let isChanged = options.force === true;

    if (!isChanged) {
      try {
        const destStat = await stat(destFile);
        const srcStat = await stat(srcFile);
        const isTimeChanged = srcStat.mtimeMs > destStat.mtimeMs;
        const isSizeChanged = srcStat.size !== destStat.size;
        isChanged = isTimeChanged || isSizeChanged;
      } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          isChanged = true; // file does not exists.
        } else {
          throw error;
        }
      }
    }

    if (isChanged) {
      if (isSingFileCopy) destDir = path.dirname(dest);
      await mkdir(destDir, { recursive: true });
      await copyFile(srcFile, destFile);
      result.copyCount++;

      if (options.logLevel === "verbose") console.log(`[copy-changed] ${srcFile} -> ${destFile}`);
    } else {
      result.skipCount++;
      if (options.logLevel === "verbose") console.log(`[SKIP] ${file} -> ${destFile}`);
    }
  }

  if (options.logLevel !== "silent") {
    console.log(
      `${headerInfo}: ${result.copyCount} file(s) copied, ${result.skipCount} file(s) skipped.`,
    );
  }

  process.chdir(cwdSave);
  return result;
}
