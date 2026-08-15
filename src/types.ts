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

  logLevel?: "normal" | "verbose" | "silent";

  // options to tinyglobby.
  globOptions?: GlobOptions;

  //----- hooks for customization. Each defaults to the matching
  // `default*` export below (mostly responsible for `logLevel` output);
  // supplying your own fully replaces the default for that event. Hooks
  // may be sync or async - async hooks are awaited before continuing.

  // test if file is changed.
  onCheckChanged?: (
    srcFile: string,
    destFile: string,
    options: CopyOptions,
  ) => boolean | Promise<boolean>;

  // called after clearing dest.
  onClearDest?: (delPatterns: string[], options: CopyOptions) => void | Promise<void>;

  // called after each copy operation.
  onCopy?: (srcFile: string, destFile: string, options: CopyOptions) => void | Promise<void>;

  // called after each skipped operation.
  onSkip?: (srcFile: string, destFile: string, options: CopyOptions) => void | Promise<void>;

  // called at the end of whole operation.
  onFinish?: (result: CopyResult, options: CopyOptions) => void | Promise<void>;
}

export interface CopyResult {
  copyCount: number;
  skipCount: number;
}
