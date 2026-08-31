import type { Logger, LogLevel } from "@wicle/tiny-logger";
import type { GlobOptions } from "tinyglobby";

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

  // Controls whether dest is interpreted as a file or directory. "auto"
  // preserves the existing filesystem/extension-based detection.
  destType?: "auto" | "file" | "directory";

  /*
    If true, empty whole dest.
    If glob, delete matched files only within the dest folder. (using del module).
    The glob should be relative path from the dest.
    When dest resolves to a single file, this deletes that file (if it exists)
    before copying - note that if `src` doesn't match anything, dest is left
    deleted with nothing to replace it.
  */
  clearDest?: boolean | string | readonly string[];

  // overwrite the destination. default is false.
  force?: boolean;

  logger?: Logger;

  logLevel?: LogLevel;

  // options to tinyglobby.
  globOptions?: GlobOptions;

  dryRun?: boolean;

  //----- hooks for customization. Each defaults to the matching
  // `default*` export below (mostly responsible for `logLevel` output);
  // supplying your own fully replaces the default for that event. Hooks
  // may be sync or async: copyChanged (async) awaits either kind, but
  // copyChangedSync cannot await a Promise - if a hook returns one there,
  // copyChangedSync logs a warning and falls back to a safe default
  // instead of awaiting it (see copyChangedSync.ts).

  // test if file is changed.
  onCheckChanged?: (
    srcFile: string,
    destFile: string,
    options: Required<CopyOptions>,
  ) => boolean | Promise<boolean>;

  // called after clearing dest.
  onClearDest?: (delPatterns: string[], options: Required<CopyOptions>) => void | Promise<void>;

  // called after each copy operation.
  onCopy?: (
    srcFile: string,
    destFile: string,
    options: Required<CopyOptions>,
  ) => void | Promise<void>;

  // called after each skipped operation.
  onSkip?: (
    srcFile: string,
    destFile: string,
    options: Required<CopyOptions>,
  ) => void | Promise<void>;

  // called at the end of whole operation.
  onFinish?: (result: CopyResult, options: Required<CopyOptions>) => void | Promise<void>;
}

export interface CopyResult {
  copyCount: number;
  skipCount: number;
}
