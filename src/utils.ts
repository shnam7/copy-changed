import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import commonPathPrefix from "common-path-prefix";

import type { CopyParam } from "./types";

export const arrayify = <T>(value: T | readonly T[]): T[] =>
  Array.isArray(value) ? [...value] : [value as T];

export const isCopyParam = (value: unknown): value is CopyParam =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "src" in value &&
  "dest" in value;

export const stripTrailingSep = (p: string): string => (p.endsWith(path.sep) ? p.slice(0, -1) : p);

// Detects functions declared with the `async` keyword (async function /
// async arrow). This only catches that common case - a plain function
// that manually returns a Promise (no `async` keyword) won't match. See
// "Sync API hook constraints" in README.md.
export const isAsyncFunction = (fn: unknown): boolean =>
  typeof fn === "function" && fn.constructor.name === "AsyncFunction";

export const resolveGlobBase = (parents: string[], cwd: string): string => {
  const uniqueParents = [...new Set(parents)];
  if (uniqueParents.length === 1) return uniqueParents[0] as string;

  const prefix = stripTrailingSep(commonPathPrefix(uniqueParents));
  return prefix || cwd;
};

const guessIsDirectoryForMissingPath = (pathName: string): boolean =>
  pathName.endsWith(path.sep) || path.extname(pathName).length === 0;

export const isDirectory = async (pathName: string): Promise<boolean> => {
  try {
    const stats = await stat(pathName);
    return stats.isDirectory();
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return guessIsDirectoryForMissingPath(pathName);
    }
    throw error;
  }
};

export const isDirectorySync = (pathName: string): boolean => {
  try {
    const stats = statSync(pathName);
    return stats.isDirectory();
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return guessIsDirectoryForMissingPath(pathName);
    }
    throw error;
  }
};
