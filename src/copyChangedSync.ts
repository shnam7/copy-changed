import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { getDefaultLogger, withVerbose } from "@wicle/tiny-logger";
import { deleteSync } from "del";
import globParent from "glob-parent";
import { globSync, isDynamicPattern } from "tinyglobby";
import {
  defaultOnCheckChanged,
  defaultOnClearDest,
  defaultOnCopy,
  defaultOnFinish,
  defaultOnSkip,
} from "./hooks";
import type { CopyOptions, CopyParam, CopyResult } from "./types";
import { arrayify, isAsyncFunction, isCopyParam, isDirectorySync, resolveGlobBase } from "./utils";

export type { CopyOptions, CopyParam, CopyResult };
export { defaultOnCheckChanged, defaultOnClearDest, defaultOnCopy, defaultOnFinish, defaultOnSkip };

const HOOK_NAMES = ["onCheckChanged", "onClearDest", "onCopy", "onSkip", "onFinish"] as const;

// copyChangedSync's hooks are typed to allow `T | Promise<T>` (same shape
// as the async API - see types.ts) so that one CopyOptions type serves
// both APIs, but copyChangedSync itself never awaits anything. Passing an
// async hook here means its result is silently ignored - so we check
// once, upfront, whether each hook was declared with the `async` keyword
// and warn if so. This only catches hooks declared `async`; a hook that
// manually returns a Promise without that keyword is not detected here -
// see the "Sync API hook constraints" section in README.md.
function warnIfAsyncHooksPresent(opts: Required<CopyOptions>): void {
  for (const hookName of HOOK_NAMES) {
    if (isAsyncFunction(opts[hookName])) {
      opts.logger.warn(
        `copyChangedSync: '${hookName}' is an async function, but copyChangedSync cannot await ` +
          "hooks - its result will be ignored. Pass a synchronous hook when using copyChangedSync.",
      );
    }
  }
}

/**
 * Synchronous counterpart of `copyChanged`/`copyChangedAsync`. Same
 * semantics, but every filesystem call happens synchronously. Hooks are
 * expected to be synchronous - an async hook (declared with `async`) is
 * detected upfront and logged as a warning, since copyChangedSync cannot
 * await it. See "Sync API hook constraints" in README.md.
 *
 * @param src Source pattern(s), a glob string or an array of glob strings (input to tinyglobby)
 * @param dest Destination directory or a file.
 * @param options CopyOptions
 */
export function copyChangedSync(
  src: string | readonly string[],
  dest: string,
  options?: CopyOptions,
): CopyResult;

/**
 * Synchronous counterpart of `copyChanged`/`copyChangedAsync`.
 *
 * @param params Single CopyParam or an array of CopyParam's.
 */
export function copyChangedSync(
  params: CopyParam | readonly CopyParam[],
  defaultOptions?: CopyOptions,
): CopyResult;

/**
 * copyChangedSync implementation.
 */
export function copyChangedSync(
  arg1: string | readonly string[] | CopyParam | readonly CopyParam[],
  arg2?: string | CopyOptions,
  options: CopyOptions = {},
): CopyResult {
  const result: CopyResult = { copyCount: 0, skipCount: 0 };

  // Single CopyParam object.
  if (isCopyParam(arg1)) {
    const defaultOptions = arg2 as CopyOptions;
    return copyChangedSync(arg1.src, arg1.dest, { ...defaultOptions, ...arg1.options });
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
        const r = copyChangedSync(param, defaultOptions);
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
    onCheckChanged: defaultOnCheckChanged,
    onClearDest: defaultOnClearDest,
    onCopy: defaultOnCopy,
    onSkip: defaultOnSkip,
    onFinish: defaultOnFinish,
    ...options,

    // Resolve the logger, then guarantee it has a `.verbose` method -
    // README documents "any ts-log-compatible logger" (e.g. `console`),
    // and plain ts-log loggers don't define `.verbose` at all. Without
    // this, defaultOnCopy/onSkip/onClearDest calling `.verbose(...)`
    // would throw on such a logger. withVerbose() is a no-op if the
    // logger already has `.verbose` (e.g. the tiny-logger default).
    logger: withVerbose(options.logger ?? getDefaultLogger()),
  };

  // Only touch the logger's level when the caller explicitly passed
  // `logLevel` - otherwise leave a caller-supplied logger's own level (or
  // the shared default logger's "info" level) untouched, and reflect the
  // logger's actual level back onto `opts.logLevel` for consistency. Some
  // loggers (a plain `console`, the mock loggers in this project's tests)
  // don't expose `.level` at all - keep the "info" default set above
  // rather than overwriting `opts.logLevel` with `undefined`.
  if (options.logLevel) {
    opts.logger.level = options.logLevel;
  } else if (opts.logger.level) {
    opts.logLevel = opts.logger.level;
  }

  warnIfAsyncHooksPresent(opts);

  const srcPatterns = arrayify(arg1 as string | readonly string[]);
  const cwd = path.resolve(opts.cwd);
  const destAbs = path.resolve(cwd, arg2 as string);
  const isDestDirectory = isDirectorySync(destAbs);
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

      if (!opts.dryRun) deleteSync(delPatterns, { cwd: destBase });
      opts.onClearDest(delPatterns, opts);
    } else {
      // Must be deleteSync (an earlier draft mistakenly used deleteAsync
      // without await here, breaking the synchronous contract).
      if (!opts.dryRun) deleteSync(destAbs, { cwd: destBase });
      opts.onClearDest([destAbs], opts);
    }
  }

  // globSync must come from tinyglobby, not node:fs - Node's own
  // fs.globSync is a different, incompatible glob implementation.
  const files = globSync([...srcPatterns], { ...opts.globOptions, cwd });
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

    if (opts.force || opts.onCheckChanged(srcFile, destFile, opts)) {
      if (!opts.dryRun) {
        mkdirSync(destDir, { recursive: true });
        copyFileSync(srcFile, destFile);
      }
      result.copyCount++;
      opts.onCopy(srcFile, destFile, opts);
    } else {
      result.skipCount++;
      opts.onSkip(srcFile, destFile, opts);
    }
  }

  opts.onFinish(result, opts);
  return result;
}
