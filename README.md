# copy-changed

A Node.js utility that copies only changed files from source to destination.
It compares file modification time and size to determine whether a file should be copied, helping reduce redundant work in build or sync tasks.

## Features

- Copy only changed files, determined by comparing file modification time and size.
- Glob support using **[tinyglobby](https://github.com/SuperchupuDev/tinyglobby)**.
- Preserves relative directory structure by finding each pattern's common glob parent, using **[common-path-prefix](https://github.com/novemberborn/common-path-prefix)**.
- Selective destination clearing with glob support.
- Dry-run mode to preview copy results without modifying the filesystem.
- Pluggable logging using [`@wicle/tiny-logger`](https://github.com/shnam7/tiny-logger)'s `Logger` interface (a `ts-log`-compatible interface with an added `verbose` level).
- Customize behavior with hooks: override change detection or add custom logging and side effects.
- Safe for concurrent calls.

## Installation

```bash
npm install copy-changed
```

## Usage

### Basic Example

```ts
import { copyChangedAsync } from "copy-changed";

await copyChangedAsync("src/**/*.js", "dist", {
  logLevel: "verbose",
});
```

### Copy a Single File

```ts
await copyChangedAsync("src/index.html", "dist/index.html");
```

### Multiple Copy Tasks

```ts
await copyChangedAsync([
  { src: "src/**/*.js", dest: "dist/js" },
  { src: "src/**/*.css", dest: "dist/css", options: { force: true } },
]);
```

Pass a second argument to apply shared defaults across every task - a task's own `options` still wins where the two overlap:

```ts
await copyChangedAsync(
  [
    { src: "src/**/*.js", dest: "dist/js" },
    { src: "src/**/*.css", dest: "dist/css", options: { force: true } }, // force wins over the default below
  ],
  { logLevel: "verbose" },
);
```

### Preview with Dry Run

```ts
const { copyCount, skipCount } = await copyChangedAsync("src/**/*.js", "dist", {
  dryRun: true,
  logLevel: "verbose",
});
// Nothing on disk changes - `copyCount`/`skipCount` and the verbose log
// describe what a real run would do.
```

### Synchronous API

`copyChangedSync` is the synchronous version of `copyChangedAsync` with the same interface.

```ts
import { copyChangedSync } from "copy-changed";

const { copyCount, skipCount } = copyChangedSync("src/**/*.js", "dist", {
  logLevel: "verbose",
});
```

See [Sync API hook constraints](#sync-api-hook-constraints) for how it handles hooks.

## API

### copyChangedAsync(src, dest, options)

Copies files matching `src` patterns into `dest`.
Only files that have changed (by modification time or size) are copied.
- **src**: `string | string[]`
  Glob pattern(s) or file path(s).
  If `dest` is a single file, `src` must be a single non-glob file.

- **dest**: `string`
  Destination directory or file path.

- **options**: `CopyOptions` (optional)
  See below.

### copyChangedAsync(params, defaultOptions?)

Accepts a single `CopyParam` object or an array of them:

```ts
interface CopyParam {
  src: string | readonly string[];
  dest: string;
  options?: CopyOptions;
}
```

- **params**: A single `CopyParam` or `CopyParam[]`.
- **defaultOptions**: `CopyOptions` (optional) - merged into every param's `options`. Where the two overlap, the param's own `options` wins (see [Multiple Copy Tasks](#multiple-copy-tasks)).

### copyChangedSync

- `copyChangedSync(src, dest, options)`
- `copyChangedSync(params, defaultOptions?)`

Synchronous counterpart of `copyChangedAsync` above with the same interface.

### copyChanged()

Alias for `copyChangedAsync()`.

### CopyOptions

```ts
interface CopyOptions {
  cwd?: string;
  destType?: "auto" | "file" | "directory";
  clearDest?: boolean | string | readonly string[];
  force?: boolean;
  logger?: Logger; // from `@wicle/tiny-logger` - extends `ts-log`'s Logger with a `verbose` method
  logLevel?: "trace" | "debug" | "verbose" | "info" | "warn" | "error" | "fatal" | "silent";
  globOptions?: GlobOptions;
  dryRun?: boolean;
  onCheckChanged?: (
    srcFile: string,
    destFile: string,
    options: Required<CopyOptions>,
  ) => boolean | Promise<boolean>;
  onClearDest?: (delPatterns: string[], options: Required<CopyOptions>) => void | Promise<void>;
  onCopy?: (
    srcFile: string,
    destFile: string,
    options: Required<CopyOptions>,
  ) => void | Promise<void>;
  onSkip?: (
    srcFile: string,
    destFile: string,
    options: Required<CopyOptions>,
  ) => void | Promise<void>;
  onFinish?: (result: CopyResult, options: Required<CopyOptions>) => void | Promise<void>;
}
```

- **cwd**: Base directory for resolving paths. Defaults to `process.cwd()`.

- **destType**: Controls how `dest` is interpreted.
  - `"auto"`: Uses the existing filesystem and extension-based detection.
  - `"file"`: Treats `dest` as a file, including a new file without an extension or a path ending in `/` or `\\`. Trailing separators are normalized away, so `"output/"` is treated as the file `"output"`; copying fails if that resolved path is an existing directory.
  - `"directory"`: Treats `dest` as a directory, regardless of its name or extension.
  - Default: `"auto"`.

- **clearDest**:
  - `true`: empties the destination directory.
  - `string | string[]`: glob(s) relative to `dest` - deletes only the matched files.
  - If `dest` resolves to a single file, this deletes that file before copying - note that if `src` doesn't match anything, `dest` is left deleted with nothing to replace it.
  - When `dryRun` is `true`, the deletion is skipped but `onClearDest` still runs.
  - Default: `false`

- **force**: If `true`, always overwrite destination files.
  - Default: `false`

- **logger**: A [`@wicle/tiny-logger`](https://github.com/shnam7/tiny-logger) `Logger` - `ts-log`'s interface (`trace`/`debug`/`info`/`warn`/`error`/`fatal`) plus a required `verbose` method - used by the default hooks below to print `logLevel` output. A plain `ts-log` logger (e.g. `console`) doesn't satisfy this by itself; wrap it with tiny-logger's `withVerbose()` helper to add a `verbose` method. Falls back to a shared, lazily-created default logger if you don't supply one - it's only constructed once per process, not once per call.
  - Default: the shared default logger (see [Logging](#logging)).

- **logLevel**: Controls logging verbosity. Accepts one of `@wicle/tiny-logger`'s log levels (`"trace"`/`"debug"`/`"verbose"`/`"info"`/`"warn"`/`"error"`/`"fatal"`), or `"silent"` to disable logging entirely.
  - `"verbose"`: detailed per-file logs (`onCopy`/`onSkip`/`onClearDest` messages)
  - `"info"`: summary only (the `onFinish` message)
  - `"silent"`: no logs
  - Default: `"info"` - but if you pass a `logger` and omit `logLevel`, that logger's own level is left as-is instead of being reset to `"info"` (see [Logging](#logging)).
  - Ignored for any event that has a custom hook (see [Hooks](#hooks)).

- **globOptions**: Options passed through to tinyglobby.

- **dryRun**: If `true`, skips every built-in filesystem mutation - `clearDest`'s delete, `mkdir`, and the actual file copy - while still running change detection, hooks, logging, and returning the `CopyResult` that describes what would have happened.
  - Default: `false`

- **onCheckChanged**, **onClearDest**, **onCopy**, **onSkip**, **onFinish**: optional hooks. See [Hooks](#hooks).

### CopyResult

Returned by `copyChangedAsync` (as a `Promise<CopyResult>`) and `copyChangedSync` (directly):

```ts
interface CopyResult {
  copyCount: number; // number of files copied
  skipCount: number; // number of files skipped
}
```

## Hooks

Each hook fully replaces the default behavior for its event - including the built-in `logLevel` output - so if you supply a hook, you're responsible for any logging it should do. Hooks may be sync or async; `copyChangedAsync` awaits either kind before continuing. `copyChangedSync` cannot await, so it expects synchronous hooks - see [Sync API hook constraints](#sync-api-hook-constraints).

| Hook             | Called                                                         | Signature                                                                            |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `onCheckChanged` | To decide whether a matched file should be copied              | `(srcFile, destFile, options: Required<CopyOptions>) => boolean \| Promise<boolean>` |
| `onClearDest`    | After `clearDest` removes files (or the single dest file)      | `(delPatterns, options: Required<CopyOptions>) => void \| Promise<void>`             |
| `onCopy`         | After a file is copied                                         | `(srcFile, destFile, options: Required<CopyOptions>) => void \| Promise<void>`       |
| `onSkip`         | After a file is skipped (unchanged)                            | `(srcFile, destFile, options: Required<CopyOptions>) => void \| Promise<void>`       |
| `onFinish`       | Once, after all files are processed - regardless of `logLevel` | `(result, options: Required<CopyOptions>) => void \| Promise<void>`                  |

All hooks receive the fully-resolved `Required<CopyOptions>` (defaults already applied), not the partial options you passed in - so, for example, `options.logger` and `options.cwd` are always defined inside a hook.

```ts
await copyChangedAsync("src/**/*.js", "dist", {
  onCopy: (srcFile, destFile) => console.log(`copied ${srcFile}`),
  onFinish: (result) => sendMetric("files.copied", result.copyCount),
});
```

`onCheckChanged` is not called when `force: true` - every matched file is copied unconditionally in that case.

### Default hook implementations

The default implementation of each hook (the one used when you don't supply your own) is also exported, so a custom hook can call through to it and build on top of the default behavior instead of replacing it entirely:

```ts
import { copyChangedAsync, defaultOnCopy } from "copy-changed";

await copyChangedAsync("src/**/*.js", "dist", {
  logLevel: "verbose",
  onCopy: async (srcFile, destFile, options) => {
    defaultOnCopy(srcFile, destFile, options); // keep the built-in verbose log
    await notifyBuildTool(destFile);
  },
});
```

Available as `defaultOnCheckChanged` (for `copyChangedSync`), `defaultOnCheckChangedAsync` (for `copyChangedAsync`), `defaultOnClearDest`, `defaultOnCopy`, `defaultOnSkip`, and `defaultOnFinish` - the last four are shared by both APIs.

### Sync API hook constraints

`copyChangedSync`'s hooks are typed the same as `copyChangedAsync`'s (`T | Promise<T>`), so passing an async hook isn't a type error - but `copyChangedSync` cannot await one. An async `onCheckChanged` returns a Promise rather than a boolean, so it is treated as `false`; the result of any other async hook is ignored. A warning is logged once per hook, upfront, before any files are processed:

```ts
copyChangedSync("src/**/*.js", "dist", {
  onCheckChanged: async (srcFile, destFile) => checkRemotely(srcFile, destFile), // warned and treated as false
});
// logs: copyChangedSync: 'onCheckChanged' is an async function, but copyChangedSync
// cannot await hooks - its return value is treated as false. Pass a synchronous hook when
// using copyChangedSync.
```

This detection only catches hooks declared with the `async` keyword - a plain function that manually returns a `Promise` (e.g. `() => somePromise`, with no `async` keyword) is not detected and will misbehave silently. Always use a genuinely synchronous hook with `copyChangedSync`.

## Logging

By default, `copyChangedAsync`/`copyChangedSync` log through a shared [`@wicle/tiny-logger`](https://github.com/shnam7/tiny-logger) instance, exposed via its `Logger` interface - `ts-log`'s interface plus a `verbose` method - so you can supply your own logger as long as it satisfies that.

`logLevel` only overrides the logger's level when you pass it explicitly - omit it and a custom logger keeps whatever level it was created with:

```ts
import { copyChangedAsync } from "copy-changed";
import { createLogger, withVerbose } from "@wicle/tiny-logger";

// Just set the log level on the shared default logger.
await copyChangedAsync("src/**/*.js", "dist", {
  logLevel: "verbose",
});

// Supply a custom logger already configured with its own level - since
// `logLevel` is omitted here, the logger's "verbose" level is kept as-is.
const verboseLogger = createLogger({ level: "verbose" });
await copyChangedAsync("src/**/*.js", "dist", {
  logger: verboseLogger,
});

// Supply a custom logger AND an explicit `logLevel` - the explicit value
// always wins, so this downgrades `verboseLogger` from "verbose" to "debug".
await copyChangedAsync("src/**/*.js", "dist", {
  logger: verboseLogger,
  logLevel: "debug",
});

// Plain `ts-log` loggers (like `console`) don't have `verbose`, so wrap them
// with `withVerbose()` to satisfy the `Logger` interface.
await copyChangedAsync("src/**/*.js", "dist", {
  logger: withVerbose(console),
});
```

The default logger's output (shown in the [example below](#example-output-verbose-mode)) is a timestamp and level tag, colorized when the terminal supports it - there's no `"[copy-changed]"` prefix or other tagging. A custom logger prints messages exactly as passed to it.

## Notes

- If `dest` is a file, `src` must be a single non-glob file.
- In `"auto"` mode, a `dest` ending in `/` or `\\` is treated as a directory. A non-existent destination without an extension is also treated as a directory.
- Set `destType: "file"` or `destType: "directory"` to override automatic destination detection, including trailing slash detection.
- If `dest` resolves to a single file, `clearDest` deletes that file before copying (see the `clearDest` option above).

Handling the `dest` argument:

```ts
// copy src/a.txt to dest directory. If dest does not exist, it is created.
copyChangedAsync("src/a.txt", "dest/");

// If dest is an existing directory, copy src/a.txt to dest/.
// Otherwise, copy src/a.txt to 'dest' as a file.
copyChangedAsync("src/a.txt", "dest");

// dest.txt is always treated as a file, because it has an extension.
copyChangedAsync("src/a.txt", "dest.txt");

// Explicit destType takes precedence over automatic detection.
// The trailing slash is normalized away, so this writes to the file "dest".
copyChangedAsync("src/a.txt", "dest/", { destType: "file" });
```

## Example Output (verbose mode)

```sh
10:32:19 AM VERBOSE Copy: src/app.js -> dist/app.js
10:32:19 AM VERBOSE Skip: src/util.js -> dist/util.js
10:32:19 AM INFO 1 file(s) copied, 1 file(s) skipped.
```

## License

MIT
