import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { arrayify, isArray, isObject, isString } from "@wicle/is";
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
  // current working directory. (needed when src is relative path)
  cwd?: string;

  // If true, empty whole dest.
  // If glob, delete matched files only within the dest folder. (using multimatch).
  // The glob should be relative path from the dest.
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

export async function copyChanged(
  src: string | readonly string[],
  dest: string,
  options?: CopyOptions,
): Promise<CopyResult>;

export async function copyChanged(params: CopyParam | readonly CopyParam[]): Promise<CopyResult>;

/**
 * Copy changed files to destination directory.
 * File change is determined by comparing modified time and size.
 *
 * Note:
 *  If dest is file, then src should also be single file, not a glob.
 *
 * @arg1 arg1 Source patterns, a glob string or an array of glob strings (input to tinyglobby).
 * @param dest Destination directory or file.
 * @param options CopyOptions
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

  // // handle array input recurrsively.
  // if (isArray(arg1)) {
  //   if ((arg1 as []).length === 0) return result;
  //   if (isString(arg1[0]))
  //     return copyChanged({ src: arg1 as string[], dest, options } as CopyParam);

  //   for (const entry of arg1 as CopyParam[]) {
  //     const r = await copyChanged(entry);
  //     result.copyCount += r.copyCount;
  //     result.skipCount += r.skipCount;
  //   }
  //   return result;
  // }

  // // handle CopyParam input type
  // if (isObject(arg1) && Object.hasOwn(arg1, "src")) {
  //   return copyChanged(arg1.src, arg1.dest, arg1.options);
  // }

  // here, src is string or string[] which is for glob param to tinyglobby.

  const cwdSave = process.cwd();
  if (options.cwd) process.chdir(options.cwd);

  const src = arrayify(arg1) as string[];
  // console.log(`=====0.0:src='${src}' dest='${dest}'`);
  if (src.length === 0 || !src[0]) return result;

  const cwd = process.cwd();
  const srcPatterns = arrayify(src).map((pattern) =>
    path.relative(cwd, path.resolve(cwd, pattern)),
  );
  dest = path.relative(cwd, path.resolve(cwd, dest as string));
  // console.log(`=====0.1:cwd='${cwd}' srcPatterns='${srcPatterns}' dest='${dest}'`);

  const isDestDirectory = await isDirectory(dest);
  const destBase = isDestDirectory ? dest : path.dirname(dest);
  // console.log(`=====0.2: destBase=${destBase} isDestDirectory:${isDestDirectory}`);

  let isSingFileCopy = false;
  // src should be a single file when the dest is a file, not a directory.
  if (!isDestDirectory) {
    // console.log(`=====0.3: ${srcPatterns.length} isDyn=${isDynamicPattern(srcPatterns[0])}`);
    if (srcPatterns.length > 1 || isDynamicPattern(srcPatterns[0] as string)) {
      process.chdir(cwdSave);
      throw Error(`Glob pattern cannot be copied to file: '${arg1}' -> dest='${dest}'.`);
    }
    isSingFileCopy = true;
  }

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
  // console.log(`=====1.0.0:srcPatterns=['${srcPatterns}'] globBase='${globBase}'`);
  // console.log(`=====1.0.1=== files=${files.length}`);
  // console.log(`=====1.0.1=== ${files}`);

  for await (const file of files) {
    const srcFile = path.relative(cwd, file); // relative path of file
    const variablePath = path.relative(globBase, srcFile);
    // console.log(`=====1.1.0:srcFile=${srcFile} varPath=${variablePath} file=${file} `);

    let destDir = path.join(destBase, path.dirname(variablePath));
    const destFile = isDestDirectory ? path.join(destBase, variablePath) : dest;
    // console.log(`=====1.1.1:destDir=${destDir} destFile=${destFile}}`);

    // console.log(`===:srcBase=${srcBase}:===:cwd=${cwd}:===:file=${file}`);
    // const p1 = srcPath;
    // const p2 = variablePath;
    // const p3 = destPath;
    // console.log(`===B:${p1}:===:${p2}:===:${p3}`);

    let isChanged = options.force === true;

    if (!isChanged) {
      try {
        const destStat = await stat(destFile);
        const srcStat = await stat(srcFile);
        const isTimeChanged = srcStat.mtimeMs > destStat.mtimeMs;
        const isSizeChanged = srcStat.size !== destStat.size;
        isChanged = isTimeChanged || isSizeChanged;
        // console.log(`=====5.0:isChanged=${isChanged}`);
      } catch (error) {
        // console.log(`=====5.1: ${error}`);
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          isChanged = true; // file does not exists.
        } else {
          // console.log(`=====5.2: ${error}`);
          throw error;
        }
      }
    }

    if (isChanged) {
      if (isSingFileCopy) destDir = path.dirname(dest);

      // console.log(`=====1.1: destDir:${destDir}, srcPath:${srcFile} ${destFile}`);
      await mkdir(destDir, { recursive: true });
      // console.log(`=====2.1.0: mkdir=${destDir}`);
      // console.log(`=====2.1.1: copyFile=${srcFile} -> ${destFile}`);

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
