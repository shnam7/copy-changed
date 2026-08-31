import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LogLevel } from "@wicle/tiny-logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirs, removeTempDirs, type TempDirs } from "./helpers/fixtures.ts";
import { createMockLogger } from "./helpers/mockLogger.ts";
import {
  getRealStat,
  getRealStatSync,
  makeStatErrorOverride,
  makeStatSyncErrorOverride,
  type StatFn,
  type StatSyncFn,
} from "./helpers/statMock.ts";

const state = vi.hoisted(() => ({
  statOverride: null as StatFn | null,
  statSyncOverride: null as StatSyncFn | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: ((...args: Parameters<StatFn>) =>
      state.statOverride ? state.statOverride(...args) : actual.stat(...args)) as StatFn,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((...args: Parameters<StatSyncFn>) =>
      state.statSyncOverride
        ? state.statSyncOverride(...args)
        : actual.statSync(...args)) as StatSyncFn,
  };
});

const {
  defaultOnCheckChanged,
  defaultOnCheckChangedAsync,
  defaultOnClearDest,
  defaultOnCopy,
  defaultOnFinish,
  defaultOnSkip,
} = await import("../src/hooks.ts");

// Minimal `Required<CopyOptions>` stand-ins - only the fields each default
// hook actually reads (`logLevel`, `logger`) need real values. `logLevel`
// uses the same value set as CopyOptions.logLevel (tiny-logger's
// trace/debug/verbose/info/warn/error/fatal/silent), not the old
// normal/verbose/silent scheme.
const opts = (overrides: { logLevel?: LogLevel; logger?: unknown } = {}) =>
  ({ logLevel: "info", logger: createMockLogger(), ...overrides }) as never;

describe("defaultOnCheckChangedAsync", () => {
  let dirs: TempDirs;

  afterEach(async () => {
    state.statOverride = null;
    if (dirs) await removeTempDirs(dirs.tmpRoot);
  });

  it("returns true when the dest file does not exist", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    await writeFile(srcFile, "hello");

    const changed = await defaultOnCheckChangedAsync(
      srcFile,
      path.join(dirs.destDir, "a.txt"),
      opts(),
    );
    expect(changed).toBe(true);
  });

  it("rethrows an ENOENT error when the src file does not exist", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    const destFile = path.join(dirs.destDir, "a.txt");
    await mkdir(dirs.destDir, { recursive: true });
    await writeFile(srcFile, "hello");
    await writeFile(destFile, "hello");

    const missingSourceError = Object.assign(new Error("source file missing"), { code: "ENOENT" });
    state.statOverride = makeStatErrorOverride(srcFile, missingSourceError, await getRealStat());

    await expect(defaultOnCheckChangedAsync(srcFile, destFile, opts())).rejects.toThrow(
      "source file missing",
    );
  });

  it("returns true when the dest file's size differs", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    const destFile = path.join(dirs.destDir, "a.txt");
    await mkdir(dirs.destDir, { recursive: true });
    await writeFile(srcFile, "a longer piece of content");
    await writeFile(destFile, "short");
    await utimes(destFile, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

    expect(await defaultOnCheckChangedAsync(srcFile, destFile, opts())).toBe(true);
  });

  it("returns true when the dest file's mtime is older than src", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    const destFile = path.join(dirs.destDir, "a.txt");
    await mkdir(dirs.destDir, { recursive: true });
    await writeFile(destFile, "hello");
    await writeFile(srcFile, "hello");
    await utimes(srcFile, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

    expect(await defaultOnCheckChangedAsync(srcFile, destFile, opts())).toBe(true);
  });

  it("returns false when size and mtime both indicate no change", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    const destFile = path.join(dirs.destDir, "a.txt");
    await mkdir(dirs.destDir, { recursive: true });
    await writeFile(srcFile, "hello");
    await writeFile(destFile, "hello");
    const t = new Date();
    await utimes(srcFile, t, t);
    await utimes(destFile, new Date(t.getTime() + 10_000), new Date(t.getTime() + 10_000));

    expect(await defaultOnCheckChangedAsync(srcFile, destFile, opts())).toBe(false);
  });

  it("rethrows a non-ENOENT stat error", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    const destFile = path.join(dirs.destDir, "a.txt");
    await mkdir(dirs.destDir, { recursive: true });
    await writeFile(srcFile, "hello");
    await writeFile(destFile, "hello");

    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    state.statOverride = makeStatErrorOverride(destFile, permissionError, await getRealStat());

    await expect(defaultOnCheckChangedAsync(srcFile, destFile, opts())).rejects.toThrow(
      "permission denied",
    );
  });
});

// Same coverage as defaultOnCheckChangedAsync above, but against the
// synchronous implementation (statSync via node:fs, not stat via
// node:fs/promises) - see the "the one hook with genuinely different I/O"
// comment in hooks.ts for why there are two separate implementations.
describe("defaultOnCheckChanged", () => {
  let dirs: TempDirs;

  afterEach(async () => {
    state.statSyncOverride = null;
    if (dirs) await removeTempDirs(dirs.tmpRoot);
  });

  it("returns true when the dest file does not exist", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    await writeFile(srcFile, "hello");

    const changed = defaultOnCheckChanged(srcFile, path.join(dirs.destDir, "a.txt"), opts());
    expect(changed).toBe(true);
  });

  it("rethrows an ENOENT error when the src file does not exist", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    const destFile = path.join(dirs.destDir, "a.txt");
    await mkdir(dirs.destDir, { recursive: true });
    await writeFile(srcFile, "hello");
    await writeFile(destFile, "hello");

    const missingSourceError = Object.assign(new Error("source file missing"), { code: "ENOENT" });
    state.statSyncOverride = makeStatSyncErrorOverride(
      srcFile,
      missingSourceError,
      await getRealStatSync(),
    );

    expect(() => defaultOnCheckChanged(srcFile, destFile, opts())).toThrow("source file missing");
  });

  it("returns true when the dest file's size differs", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    const destFile = path.join(dirs.destDir, "a.txt");
    await mkdir(dirs.destDir, { recursive: true });
    await writeFile(srcFile, "a longer piece of content");
    await writeFile(destFile, "short");
    await utimes(destFile, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

    expect(defaultOnCheckChanged(srcFile, destFile, opts())).toBe(true);
  });

  it("returns true when the dest file's mtime is older than src", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    const destFile = path.join(dirs.destDir, "a.txt");
    await mkdir(dirs.destDir, { recursive: true });
    await writeFile(destFile, "hello");
    await writeFile(srcFile, "hello");
    await utimes(srcFile, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

    expect(defaultOnCheckChanged(srcFile, destFile, opts())).toBe(true);
  });

  it("returns false when size and mtime both indicate no change", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    const destFile = path.join(dirs.destDir, "a.txt");
    await mkdir(dirs.destDir, { recursive: true });
    await writeFile(srcFile, "hello");
    await writeFile(destFile, "hello");
    const t = new Date();
    await utimes(srcFile, t, t);
    await utimes(destFile, new Date(t.getTime() + 10_000), new Date(t.getTime() + 10_000));

    expect(defaultOnCheckChanged(srcFile, destFile, opts())).toBe(false);
  });

  it("rethrows a non-ENOENT stat error", async () => {
    dirs = await createTempDirs();
    const srcFile = path.join(dirs.srcDir, "a.txt");
    const destFile = path.join(dirs.destDir, "a.txt");
    await mkdir(dirs.destDir, { recursive: true });
    await writeFile(srcFile, "hello");
    await writeFile(destFile, "hello");

    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    state.statSyncOverride = makeStatSyncErrorOverride(
      destFile,
      permissionError,
      await getRealStatSync(),
    );

    expect(() => defaultOnCheckChanged(srcFile, destFile, opts())).toThrow("permission denied");
  });
});

describe("defaultOnClearDest", () => {
  it("logs a verbose message with the delete patterns when logLevel is verbose or more permissive", () => {
    const logger = createMockLogger();
    defaultOnClearDest(["/dest/*", "!/dest/keep.txt"], opts({ logLevel: "verbose", logger }));

    expect(logger.verbose).toHaveBeenCalledWith(expect.stringContaining("/dest/*,!/dest/keep.txt"));
  });

  it("does not log when logLevel is less permissive than verbose (the default, info)", () => {
    const logger = createMockLogger();
    defaultOnClearDest(["/dest/*"], opts({ logLevel: "info", logger }));
    expect(logger.verbose).not.toHaveBeenCalled();
  });
});

describe("defaultOnCopy", () => {
  it("logs a verbose message with resolved paths when logLevel is verbose or more permissive", () => {
    const logger = createMockLogger();
    defaultOnCopy("/src/a.txt", "/dest/a.txt", opts({ logLevel: "verbose", logger }));
    expect(logger.verbose).toHaveBeenCalledWith("Copy: /src/a.txt -> /dest/a.txt");
  });

  it("does not log when logLevel is silent", () => {
    const logger = createMockLogger();
    defaultOnCopy("/src/a.txt", "/dest/a.txt", opts({ logLevel: "silent", logger }));
    expect(logger.verbose).not.toHaveBeenCalled();
  });
});

describe("defaultOnSkip", () => {
  it("logs a verbose message with resolved paths when logLevel is verbose or more permissive", () => {
    const logger = createMockLogger();
    defaultOnSkip("/src/a.txt", "/dest/a.txt", opts({ logLevel: "trace", logger }));
    expect(logger.verbose).toHaveBeenCalledWith("Skip: /src/a.txt -> /dest/a.txt");
  });

  it("does not log when logLevel is less permissive than verbose (the default, info)", () => {
    const logger = createMockLogger();
    defaultOnSkip("/src/a.txt", "/dest/a.txt", opts({ logLevel: "info", logger }));
    expect(logger.verbose).not.toHaveBeenCalled();
  });
});

describe("defaultOnFinish", () => {
  it("logs the summary at the default logLevel (info)", () => {
    const logger = createMockLogger();
    defaultOnFinish({ copyCount: 2, skipCount: 1 }, opts({ logLevel: "info", logger }));
    expect(logger.info).toHaveBeenCalledWith("2 file(s) copied, 1 file(s) skipped.");
  });

  it("does not log when logLevel is silent", () => {
    const logger = createMockLogger();
    defaultOnFinish({ copyCount: 0, skipCount: 0 }, opts({ logLevel: "silent", logger }));
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("does not log when logLevel is less permissive than info (e.g. error)", () => {
    const logger = createMockLogger();
    defaultOnFinish({ copyCount: 0, skipCount: 0 }, opts({ logLevel: "error", logger }));
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("still logs when logLevel is more permissive than info (e.g. verbose)", () => {
    const logger = createMockLogger();
    defaultOnFinish({ copyCount: 3, skipCount: 0 }, opts({ logLevel: "verbose", logger }));
    expect(logger.info).toHaveBeenCalledWith("3 file(s) copied, 0 file(s) skipped.");
  });
});
