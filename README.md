# copy-changed

A small JavaScript/TypeScript library that copies **only changed files** to a destination directory. A file is considered changed when its modified time or size differs from the file already at the destination, so unchanged files are skipped on repeated runs — handy for incremental build steps, static asset pipelines, or watch-mode workflows.

## Features

- **Flexible Glob Support:** Powered by `tinyglobby`, accepting a single glob string or an array of globs (including negative patterns).
- **Smart Skipping:** Copies changed files only by default. Forced overwrites are supported via options.
- **Selective Cleanup:** Clean up specific files or the entire destination directory before copying.

## Installation

```bash
npm install copy-changed
# or
bun add copy-changed
# or
pnpm add copy-changed
# or
yarn add copy-changed
```

## Usage

```ts
import { copyChanged } from "copy-changed";

const { copyCount, skipCount } = await copyChanged("src/**/*.{js,css,html}", "dist");

console.log(`${copyCount} file(s) copied, ${skipCount} file(s) skipped.`);
```

### Copying a single file

```ts
await copyChanged("src/index.html", "dist/index.html");
```

### Copying multiple files, selectively

```ts
await copyChanged(["src/**/*", "!src/index.html"], "dest");
```

### Emptying the destination before copy

```ts
// Remove everything in dist/ before copying
await copyChanged("src/**/*", "dist", { emptyDest: true });

// Remove only *.map files in dist/ before copying
await copyChanged("src/**/*", "dist", { emptyDest: "**/*.map" });

// Remove matched files, but keep anything under dist/assets
await copyChanged("src/**/*", "dist", { emptyDest: ["**/*", "!assets/**"] });
```

### Forcing a full copy

```ts
// Ignore change detection and copy every matched file
await copyChanged("src/**/*", "dist", { force: true });
```

### Custom working directory & logging

```ts
await copyChanged("**/*.ts", "dist", {
  cwd: "src", // resolve the glob relative to this directory
  logLevel: "verbose", // "normal" (default) | "verbose" | "silent"
});
```

## API

### `copyChanged(src, dest, options?)`

Copies files matching `src` into `dest`, skipping files that haven't changed.
Returns `Promise<CopyResult>`.

#### src: string | string[]

Source files in glob patterns. Single glob or an array of globs supported.

#### dest: string

Desitination path. Usually an output directory, but it can be a single file
if `src` is also a single file, not a glob pattern.

#### options?: CopyOptions

Optional settings to customize behavior.
Default is undefined.

##### options.cwd?: string

Directory the globs are resolved against.
Default value is current process's working directory, process.cwd().

#### options.emptyDest?: boolean | string | string[]

If `true`, empties the whole `dest`.
A glob pattern deletes only matching files/dirs inside the `dest`.

:--------------------------------------------------------------------------------- |
| `emptyDest` | `boolean \| string \| string[]` | `undefined` ||
| `force` | `boolean` | `false` | Copy every matched file, bypassing change detection. |
| `logLevel` | `"normal" \| "verbose" \| "silent"` | `"normal"` | `"normal"` prints a summary, `"verbose"` logs each file, `"silent"` disables logs. |

#### `CopyResult`

| Property    | Type     | Description                        |
| :---------- | :------- | :--------------------------------- |
| `copyCount` | `number` | Number of files that were copied.  |
| `skipCount` | `number` | Number of files that were skipped. |

> **Note:** If `dest` points to an existing file, `src` must resolve to a single, non-glob file path.

## License

[MIT](./LICENSE) © [Robin Nam](https://github.com/shnam7)
