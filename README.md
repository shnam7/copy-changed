# copy-changed

A Node.js utility that copies only changed files from source to destination.
It compares file modification time and size to determine whether a file should be copied, helping reduce redundant work in build or sync tasks.

## Features

- Copy changed files only by comparing both modified file time and size.
- Glob support using **[tinyglobby](https://github.com/SuperchupuDev/tinyglobby)**.
- Preserves relative directory structure, finding the common glob parent using **[common-path-prefix](https://github.com/novemberborn/common-path-prefix)**.
- Selective destination clearing with glob support.
- Dry-run mode to preview what would be copied/cleared without touching the filesystem.
- Pluggable logging via any [`ts-log`](https://github.com/dscheerens/ts-log) compatible logger.
- Customizable via hooks - override change detection, or add your own logging/side effects.
- Safe for concurrent calls.

## Installation

```bash
npm install copy-changed
```

## Usage

### Basic Example

```ts
import { copyChanged } from "copy-changed";

await copyChanged("src/**/*.js", "dist", {
  logLevel: "verbose",
});
```

### Copy a Single File

```ts
await copyChanged("src/index.html", "dist/index.html");
```

### Multiple Copy Tasks

```ts
await copyChanged([
  { src: "src/**/*.js", dest: "dist/js" },
  { src: "src/**/*.css", dest: "dist/css", options: { force: true } },
]);
```

### Preview with Dry Run

```ts
const { copyCount, skipCount } = await copyChanged("src/**/*.js", "dist", {
  dryRun: true,
  logLevel: "verbose",
});
// Nothing on disk changes - `copyCount`/`skipCount` and the verbose log
// describe what a real run would do.
```

### Synchronous API

`copyChangedSync` mirrors `copyChanged` exactly - same overloads, same `CopyOptions`, same `CopyResult` - but every filesystem call happens synchronously, for build scripts and other places `await` isn't available:

```ts
import { copyChangedSync } from "copy-changed";

const { copyCount, skipCount } = copyChangedSync("src/**/*.js", "dist", {
  logLevel: "verbose",
});
```

See [Sync API hook constraints](#sync-api-hook-constraints) for how it handles hooks.

## API

### `copyChanged(src, dest, options)`

Copies files matching `src` patterns into `dest`.
Only files that have changed (by modified time or size) are copied.

- **src**: `string | string[]`
  Glob pattern(s) or file path(s).
  If `dest` is a single file, `src` must be a single non-glob file.

- **dest**: `string`
  Destination directory or file path.

- **options**: `CopyOptions` (optional)
  See below.

### `copyChanged(params)`

Accepts a single `CopyParam` object or an array of them:

```ts
interface CopyParam {
  src: string | readonly string[];
  dest: string;
  options?: CopyOptions;
}
```

### `copyChangedSync(src, dest, options)` / `copyChangedSync(params)`

Synchronous counterpart of `copyChanged` above - same parameters, same overloads (a `src`/`dest`/`options` triple, or a single `CopyParam`/`CopyParam[]`), same `CopyOptions`, and it returns a `CopyResult` directly instead of a `Promise<CopyResult>`.

### `CopyOptions`

```ts
interface CopyOptions {
  cwd?: string;
  clearDest?: boolean | string | readonly string[];
  force?: boolean;
  logger?: Logger; // from the `ts-log` package
  logLevel?: "normal" | "verbose" | "silent";
  globOptions?: GlobOptions;
  dryRun?: boolean;
  onCheckChanged?: (srcFile: string, destFile: string, options: Required<CopyOptions>) => boolean | Promise<boolean>;
  onClearDest?: (delPatterns: string[], options: Required<CopyOptions>) => void | Promise<void>;
  onCopy?: (srcFile: string, destFile: string, options: Required<CopyOptions>) => void | Promise<void>;
  onSkip?: (srcFile: string, destFile: string, options: Required<CopyOptions>) => void | Promise<void>;
  onFinish?: (result: CopyResult, options: Required<CopyOptions>) => void | Promise<void>;
}
```

- **cwd**: Base directory for resolving paths. Defaults to `process.cwd()`.

- **clearDest**:
  - `true`: empties the destination directory.
  - `string | string[]`: glob(s) relative to `dest`, deletes only matched files.
  - If `dest` resolves to a single file, this deletes that file before copying - note that if `src` doesn't match anything, `dest` is left deleted with nothing to replace it.
  - Default: `false`

- **force**: If `true`, always overwrite destination files.
  - Default: `false`

- **logger**: A [`ts-log`](https://github.com/dscheerens/ts-log) compatible logger (`trace`/`debug`/`info`/`warn`/`error`), used by the default hooks below to print `logLevel` output. Falls back to a shared, lazily-created default logger (from [`@wicle/tiny-logger`](https://github.com/shnam7/tiny-logger)) if you don't supply one - it's only constructed once per process, not once per call.
  - Default: the shared default logger (see [Logging](#logging)).

- **logLevel**: Controls logging verbosity.
  - `"normal"`: summary only
  - `"verbose"`: detailed per-file logs
  - `"silent"`: no logs
  - Default: `"normal"`
  - Ignored for any event that has a custom hook (see [Hooks](#hooks)).

- **globOptions**: options to tinyglobby.

- **dryRun**: If `true`, skips every filesystem mutation - `clearDest`'s delete, `mkdir`, and the actual file copy - while still running change detection, hooks, and returning the `CopyResult` that describes what would have happened.
  - Caveat: when combined with `clearDest`, the preview does not simulate the deletion - `onCheckChanged` still compares against files that are still on disk, so a file `clearDest` would remove (and thus force a real copy) may be reported as "skipped" here.
  - Default: `false`

- **onCheckChanged**, **onClearDest**, **onCopy**, **onSkip**, **onFinish**: optional hooks. See [Hooks](#hooks).

### `CopyResult`

Returned by `copyChanged` (as a `Promise<CopyResult>`) and `copyChangedSync` (directly):

```ts
interface CopyResult {
  copyCount: number; // number of files copied
  skipCount: number; // number of files skipped
}
```

## Hooks

Each hook fully replaces the default behavior for its event - including the built-in `logLevel` output - so if you supply a hook, you're responsible for any logging it should do. Hooks may be sync or async; `copyChanged` awaits either kind before continuing. `copyChangedSync` cannot await, so it expects synchronous hooks - see [Sync API hook constraints](#sync-api-hook-constraints).

| Hook             | Called                                                         | Signature                                                                            |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `onCheckChanged` | To decide whether a matched file should be copied              | `(srcFile, destFile, options: Required<CopyOptions>) => boolean \| Promise<boolean>` |
| `onClearDest`    | After `clearDest` removes files (or the single dest file)      | `(delPatterns, options: Required<CopyOptions>) => void \| Promise<void>`             |
| `onCopy`         | After a file is copied                                         | `(srcFile, destFile, options: Required<CopyOptions>) => void \| Promise<void>`       |
| `onSkip`         | After a file is skipped (unchanged)                            | `(srcFile, destFile, options: Required<CopyOptions>) => void \| Promise<void>`       |
| `onFinish`       | Once, after all files are processed - regardless of `logLevel` | `(result, options: Required<CopyOptions>) => void \| Promise<void>`                  |

All hooks receive the fully-resolved `Required<CopyOptions>` (defaults already applied), not the partial options you passed in - so e.g. `options.logger` and `options.cwd` are always defined inside a hook.

```ts
await copyChanged("src/**/*.js", "dist", {
  onCopy: (srcFile, destFile) => console.log(`copied ${srcFile}`),
  onFinish: (result) => sendMetric("files.copied", result.copyCount),
});
```

`onCheckChanged` is not called when `force: true` - every matched file is copied unconditionally in that case.

### Default hook implementations

The default implementation of each hook (the one used when you don't supply your own) is also exported, so a custom hook can call through to it and build on top of the default behavior instead of replacing it entirely:

```ts
import { copyChanged, defaultOnCopy } from "copy-changed";

await copyChanged("src/**/*.js", "dist", {
  logLevel: "verbose",
  onCopy: async (srcFile, destFile, options) => {
    defaultOnCopy(srcFile, destFile, options); // keep the built-in verbose log
    await notifyBuildTool(destFile);
  },
});
```

Available as `defaultOnCheckChanged` (for `copyChangedSync`), `defaultOnCheckChangedAsync` (for `copyChanged`), `defaultOnClearDest`, `defaultOnCopy`, `defaultOnSkip`, and `defaultOnFinish` - the last four are shared by both APIs.

### Sync API hook constraints

`copyChangedSync`'s hooks are typed the same as `copyChanged`'s (`T | Promise<T>`), so passing an async hook isn't a type error - but `copyChangedSync` cannot await one. If a hook declared with the `async` keyword is passed to `copyChangedSync`, its result is ignored, and a warning is logged once per hook, upfront, before any files are processed:

```ts
copyChangedSync("src/**/*.js", "dist", {
  onCheckChanged: async (srcFile, destFile) => checkRemotely(srcFile, destFile), // ⚠️ warned and ignored
});
// logs: copyChangedSync: 'onCheckChanged' is an async function, but copyChangedSync
// cannot await hooks - its result will be ignored. Pass a synchronous hook when
// using copyChangedSync.
```

This detection only catches hooks declared with the `async` keyword - a plain function that manually returns a `Promise` (e.g. `() => somePromise`, with no `async` keyword) is not detected and will misbehave silently. Always use a genuinely synchronous hook with `copyChangedSync`.

## Logging

By default, `copyChanged`/`copyChangedSync` log through a shared [`@wicle/tiny-logger`](https://github.com/shnam7/tiny-logger) instance, exposed via its [`ts-log`](https://github.com/dscheerens/ts-log) `Logger` interface - so you can supply any `ts-log`-compatible logger of your own instead.

```ts
import { copyChanged } from "copy-changed";

await copyChanged("src/**/*.js", "dist", {
  logLevel: "verbose",
  logger: console, // any ts-log-compatible logger
});
```

The default logger's output (shown in the [example below](#example-output-verbose-mode)) is a timestamp and level tag, colorized when the terminal supports it - there's no `"[copy-changed]"` prefix or other tagging. A custom logger prints messages exactly as passed to it.

## Notes

- If `dest` is a file, `src` must be a single non-glob file.
- If **dest** does not exist in the file system, it is treated as a directory if it has no extension or ends with '/'.
- If `dest` resolves to a single file, `clearDest` deletes that file before copying (see the `clearDest` option above).
- Extension-less files may be misclassified as directories if they do not exist yet.

Handling the **dest** argument:

```ts
// copy src/a.txt to dest directory. If dest does not exist, it is created.
copyChanged("src/a.txt", "dest/");

// If dest is an existing directory, then copy src/a.txt to dest/.
// If dest is not an existing directory, then copy src/a.txt to 'dest' as a file.
copyChanged("src/a.txt", "dest");

// dest.txt is always treated as a file, because it has an extension.
copyChanged("src/a.txt", "dest.txt");
```

## Example Output (verbose mode)

```sh
10:32:19 AM INFO Copy: src/app.js -> dist/app.js
10:32:19 AM INFO Skip: src/util.js -> dist/util.js
10:32:19 AM INFO 1 file(s) copied, 1 file(s) skipped.
```

## License

MIT
