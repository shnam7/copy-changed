# copy-changed

A Node.js utility library that copies only changed files from source to destination.
It compares file modification time and size to determine whether a file should be copied, helping reduce redundant work in build or sync tasks.

## Features

- Copy changed files only by comparing both modified file time and size.
- Glob support using **[tinyglobby](https://github.com/SuperchupuDev/tinyglobby)**.
- Preserves relative directory structure, finding the common glob parent using **[common-path-prefix](https://github.com/novemberborn/common-path-prefix)**.
- Selective destination clearing with glob support.
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

### `CopyOptions`

```ts
interface CopyOptions {
  cwd?: string;
  clearDest?: boolean | string | readonly string[];
  force?: boolean;
  logLevel?: "normal" | "verbose" | "silent";
  globOptions?: GlobOptions;
  onCheckChanged?: (srcFile: string, destFile: string, options: CopyOptions) => boolean | Promise<boolean>;
  onClearDest?: (delPatterns: string[], options: CopyOptions) => void | Promise<void>;
  onCopy?: (srcFile: string, destFile: string, options: CopyOptions) => void | Promise<void>;
  onSkip?: (srcFile: string, destFile: string, options: CopyOptions) => void | Promise<void>;
  onFinish?: (result: CopyResult, options: CopyOptions) => void | Promise<void>;
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

- **logLevel**: Controls logging verbosity.
  - `"normal"`: summary only
  - `"verbose"`: detailed per-file logs
  - `"silent"`: no logs
  - Default: `"normal"`
  - Ignored for any event that has a custom hook (see [Hooks](#hooks)).

- **globOptions**: options to tinyglobby.

- **onCheckChanged**, **onClearDest**, **onCopy**, **onSkip**, **onFinish**: optional hooks. See [Hooks](#hooks).

### `CopyResult`

Returned by `copyChanged`:

```ts
interface CopyResult {
  copyCount: number; // number of files copied
  skipCount: number; // number of files skipped
}
```

## Hooks

Each hook fully replaces the default behavior for its event - including the built-in `logLevel` output - so if you supply a hook, you're responsible for any logging it should do. Hooks may be sync or async; async hooks are awaited before `copyChanged` continues.

| Hook             | Called                                                         | Signature                                                     |
| ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `onCheckChanged` | To decide whether a matched file should be copied              | `(srcFile, destFile, options) => boolean \| Promise<boolean>` |
| `onClearDest`    | After `clearDest` removes files (or the single dest file)      | `(delPatterns, options) => void \| Promise<void>`             |
| `onCopy`         | After a file is copied                                         | `(srcFile, destFile, options) => void \| Promise<void>`       |
| `onSkip`         | After a file is skipped (unchanged)                            | `(srcFile, destFile, options) => void \| Promise<void>`       |
| `onFinish`       | Once, after all files are processed - regardless of `logLevel` | `(result, options) => void \| Promise<void>`                  |

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

Available as `defaultOnCheckChanged`, `defaultOnClearDest`, `defaultOnCopy`, `defaultOnSkip`, and `defaultOnFinish`.

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
[copy-changed]: Copy: src/app.js -> dist/app.js
[copy-changed]: Skip: src/util.js -> dist/util.js
[copy-changed]: 1 file(s) copied, 1 file(s) skipped.
```

## License

MIT
