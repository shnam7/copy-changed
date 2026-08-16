import { stat } from "node:fs/promises";
import path from "node:path";
import commonPathPrefix from "common-path-prefix";
import pino from "pino";
import type { Logger } from "ts-log";
import type { CopyParam } from "./types";

//----- Internal functions -----
export const arrayify = <T>(value: T | readonly T[]): T[] =>
  Array.isArray(value) ? [...value] : [value as T];

export const isCopyParam = (value: unknown): value is CopyParam =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "src" in value &&
  "dest" in value;

export const stripTrailingSep = (p: string): string => (p.endsWith(path.sep) ? p.slice(0, -1) : p);

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
export const resolveGlobBase = (parents: string[], cwd: string): string => {
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
export const isDirectory = async (pathName: string): Promise<boolean> => {
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

export function createLogger(prefix: string): Logger {
  return pino({
    level: "trace",
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname,prefix",
        messageFormat: "[{prefix}] {msg}",
        customColors:
          "trace:gray,debug:blue,info:green,warn:yellow,error:red,fatal:bgRed,message:uncolored",
      },
    },
  }).child({ prefix });
}

// The pino + pino-pretty transport is not cheap to construct (it spins up
// a worker thread), so the default logger is built lazily, once per
// process, and reused across every `copyChanged()` call that doesn't
// supply its own `logger` - rather than re-created on every call/job.
let defaultLogger: Logger | undefined;
export function getDefaultLogger(): Logger {
  defaultLogger ??= createLogger("copy-changed");
  return defaultLogger;
}
