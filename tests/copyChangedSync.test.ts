import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockLogger } from "./helpers/mockLogger.ts";
import { getRealStatSync, makeStatSyncErrorOverride, type StatSyncFn } from "./helpers/statMock.ts";

// ---- Controllable statSync mock -----------------------------------------
// Same rationale as index.test.ts's `stat` mock, but for `statSync` -
// copyChangedSync uses node:fs's synchronous stat calls throughout, not
// node:fs/promises. Covers index.ts/copyChangedSync.ts and hooks.ts alike,
// since vi.mock intercepts by module specifier.
let statSyncOverride: StatSyncFn | null = null;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statSync: ((...args: Parameters<StatSyncFn>) => {
      if (statSyncOverride) return statSyncOverride(...args);
      return actual.statSync(...args);
    }) as StatSyncFn,
  };
});

const { copyChangedSync } = await import("../src/index.ts");

let tmpRoot: string;
let srcDir: string;
let destDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "copy-changed-sync-"));
  srcDir = path.join(tmpRoot, "src");
  destDir = path.join(tmpRoot, "dest");
  await mkdir(srcDir, { recursive: true });
});

afterEach(async () => {
  statSyncOverride = null;
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("copyChangedSync - core behavior", () => {
  it("copies files that do not yet exist in dest", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");

    const result = copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("hello");
  });

  it("copies files inside nested directories preserving structure", async () => {
    await mkdir(path.join(srcDir, "nested", "deep"), { recursive: true });
    await writeFile(path.join(srcDir, "nested", "deep", "b.txt"), "nested-content");

    const result = copyChangedSync("**/*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    expect(result.copyCount).toBe(1);
    expect(await readFile(path.join(destDir, "nested", "deep", "b.txt"), "utf8")).toBe(
      "nested-content",
    );
  });

  it("accepts an array of glob patterns", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "top-level");
    await mkdir(path.join(srcDir, "other"), { recursive: true });
    await writeFile(path.join(srcDir, "other", "b.txt"), "in-subdir");

    const result = copyChangedSync(["*.txt", "other/*.txt"], destDir, {
      cwd: srcDir,
      logLevel: "silent",
    });

    expect(result).toEqual({ copyCount: 2, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("top-level");
    expect(await readFile(path.join(destDir, "other", "b.txt"), "utf8")).toBe("in-subdir");
  });

  it("returns a no-op result for an empty src array but still clears dest", async () => {
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, "stray.txt"), "should be removed");

    const result = copyChangedSync([], destDir, {
      cwd: srcDir,
      clearDest: true,
      logLevel: "silent",
    });

    expect(result).toEqual({ copyCount: 0, skipCount: 0 });
    // Regression check: an empty srcPatterns array must not be swallowed
    // by the CopyParam[] branch - clearDest still has to run. See the
    // `typeof arg2 !== "string"` disambiguation in copyChangedSync.ts.
    await expect(readFile(path.join(destDir, "stray.txt"), "utf8")).rejects.toThrow();
  });

  it("does not throw when called as copyChangedSync([]) with no dest (CopyParam[] overload)", () => {
    // Regression check: the single-argument params overload must still
    // treat an empty array as zero CopyParam's, not fall through to the
    // srcPatterns path (where a missing `dest` would throw).
    expect(copyChangedSync([])).toEqual({ copyCount: 0, skipCount: 0 });
  });

  it("does not throw when called as copyChangedSync([], defaultOptions) with no dest", () => {
    // Regression check: `defaultOptions` (a CopyOptions object) in the
    // second argument position must not be mistaken for `dest` (a
    // string) - only a *string* second argument means the srcPatterns
    // overload was actually called.
    expect(copyChangedSync([], { logLevel: "silent" })).toEqual({ copyCount: 0, skipCount: 0 });
  });

  it("skips unchanged files and re-copies files that changed, on repeated runs", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");

    const first = copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });
    expect(first).toEqual({ copyCount: 1, skipCount: 0 });

    const second = copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });
    expect(second).toEqual({ copyCount: 0, skipCount: 1 });

    const future = new Date(Date.now() + 10_000);
    await writeFile(path.join(srcDir, "a.txt"), "changed");
    await utimes(path.join(srcDir, "a.txt"), future, future);

    const third = copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });
    expect(third).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("force option always copies regardless of change detection", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    const result = copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      force: true,
      logLevel: "silent",
    });
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("copies a single named file to an explicit destination file path", async () => {
    await writeFile(path.join(srcDir, "single.txt"), "single-content");
    const destFile = path.join(destDir, "renamed.txt");

    const result = copyChangedSync("single.txt", destFile, { cwd: srcDir, logLevel: "silent" });

    expect(result.copyCount).toBe(1);
    expect(await readFile(destFile, "utf8")).toBe("single-content");
  });

  it("throws when dest is an existing file but src is a glob pattern", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, "placeholder.txt");
    await writeFile(destFile, "placeholder");

    expect(() => copyChangedSync("*.txt", destFile, { cwd: srcDir, logLevel: "silent" })).toThrow(
      /Glob pattern cannot be copied to file/,
    );
  });

  it("treats a non-existent dest without an extension as a directory", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const freshDest = path.join(tmpRoot, "brand-new-dir");

    const result = copyChangedSync("*.txt", freshDest, { cwd: srcDir, logLevel: "silent" });

    expect(result.copyCount).toBe(1);
    expect(await readFile(path.join(freshDest, "a.txt"), "utf8")).toBe("hello");
  });

  it("uses process.cwd() when no cwd option is supplied", async () => {
    const originalCwd = process.cwd();
    process.chdir(srcDir);
    try {
      await writeFile(path.join(srcDir, "a.txt"), "hello");
      const result = copyChangedSync("*.txt", destDir, { logLevel: "silent" });
      expect(result.copyCount).toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rethrows a non-ENOENT error from the per-file stat check", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });

    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const destFilePath = path.join(destDir, "a.txt");
    statSyncOverride = makeStatSyncErrorOverride(
      destFilePath,
      permissionError,
      await getRealStatSync(),
    );

    expect(() => copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent" })).toThrow(
      "permission denied",
    );
  });
});

describe("copyChangedSync - clearDest", () => {
  it("clearDest=true removes all existing files in dest before copying", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, "stray.txt"), "should be removed");

    const result = copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      clearDest: true,
      logLevel: "silent",
    });

    expect(result.copyCount).toBe(1);
    await expect(readFile(path.join(destDir, "stray.txt"), "utf8")).rejects.toThrow();
  });

  it("clearDest with a single glob string deletes only matching files", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, "old.txt"), "old");
    await writeFile(path.join(destDir, "keep.json"), "{}");

    copyChangedSync("*.txt", destDir, { cwd: srcDir, clearDest: "*.txt", logLevel: "silent" });

    await expect(readFile(path.join(destDir, "old.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(destDir, "keep.json"), "utf8")).toBe("{}");
  });

  it("actually deletes the dest file when clearDest is set for a single-file dest", async () => {
    await writeFile(path.join(srcDir, "single.txt"), "new-content");
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, "out.txt");
    await writeFile(destFile, "old-content-that-is-much-longer-than-new");

    const result = copyChangedSync("single.txt", destFile, {
      cwd: srcDir,
      clearDest: true,
      logLevel: "silent",
    });

    expect(result.copyCount).toBe(1);
    expect(await readFile(destFile, "utf8")).toBe("new-content");
  });

  it("calls onClearDest with the delete patterns for a directory dest", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, "stray.txt"), "should be removed");
    const onClearDest = vi.fn();

    copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      clearDest: true,
      logLevel: "silent",
      onClearDest,
    });

    expect(onClearDest).toHaveBeenCalledTimes(1);
    expect(onClearDest).toHaveBeenCalledWith([path.join(destDir, "*")], expect.anything());
  });
});

describe("copyChangedSync - dryRun", () => {
  it("does not create the dest file or directory, but still reports the copy", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");

    const result = copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      dryRun: true,
      logLevel: "silent",
    });

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
    await expect(readFile(path.join(destDir, "a.txt"), "utf8")).rejects.toThrow();
  });

  it("does not delete anything when combined with clearDest", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, "stray.txt"), "should survive the dry run");

    copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      clearDest: true,
      dryRun: true,
      logLevel: "silent",
    });

    expect(await readFile(path.join(destDir, "stray.txt"), "utf8")).toBe(
      "should survive the dry run",
    );
  });
});

describe("copyChangedSync - globOptions", () => {
  it("forwards globOptions to tinyglobby (e.g. an ignore pattern)", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "keep");
    await writeFile(path.join(srcDir, "b.txt"), "ignored");

    const result = copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      logLevel: "silent",
      globOptions: { ignore: ["b.txt"] },
    });

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("keep");
    await expect(readFile(path.join(destDir, "b.txt"), "utf8")).rejects.toThrow();
  });
});

describe("copyChangedSync - event handler dispatch", () => {
  it("calls onCopy and onSkip with the resolved src/dest paths", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const onCopy = vi.fn();
    const onSkip = vi.fn();

    copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent", onCopy, onSkip });
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith(
      path.join(srcDir, "a.txt"),
      path.join(destDir, "a.txt"),
      expect.anything(),
    );
    expect(onSkip).not.toHaveBeenCalled();

    onCopy.mockClear();
    copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent", onCopy, onSkip });
    expect(onCopy).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("lets a synchronous custom onCheckChanged fully override the default logic", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    const onCheckChanged = vi.fn((_srcFile: string, _destFile: string) => true);
    const result = copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      logLevel: "silent",
      onCheckChanged,
    });

    expect(onCheckChanged).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("does not call onCheckChanged when force is true", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const onCheckChanged = vi.fn(() => false);

    const result = copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      force: true,
      logLevel: "silent",
      onCheckChanged,
    });

    expect(onCheckChanged).not.toHaveBeenCalled();
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("propagates an error thrown by a custom onCheckChanged hook", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const onCheckChanged = vi.fn(() => {
      throw new Error("boom from a custom hook");
    });

    expect(() =>
      copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent", onCheckChanged }),
    ).toThrow("boom from a custom hook");
  });

  it("calls onFinish with the final result even when logLevel is silent", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const onFinish = vi.fn();

    copyChangedSync("*.txt", destDir, { cwd: srcDir, logLevel: "silent", onFinish });

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith({ copyCount: 1, skipCount: 0 }, expect.anything());
  });
});

describe("copyChangedSync - CopyParam overload", () => {
  it("accepts a single CopyParam object", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");

    const result = copyChangedSync({
      src: "*.txt",
      dest: destDir,
      options: { cwd: srcDir, logLevel: "silent" },
    });

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("hello");
  });

  it("accepts an array of CopyParam objects and sums the results", async () => {
    const srcDir2 = path.join(tmpRoot, "src2");
    const destDir2 = path.join(tmpRoot, "dest2");
    await mkdir(srcDir2, { recursive: true });
    await writeFile(path.join(srcDir, "a.txt"), "from-1");
    await writeFile(path.join(srcDir2, "b.txt"), "from-2");

    const result = copyChangedSync([
      { src: "*.txt", dest: destDir, options: { cwd: srcDir, logLevel: "silent" } },
      { src: "*.txt", dest: destDir2, options: { cwd: srcDir2, logLevel: "silent" } },
    ]);

    expect(result).toEqual({ copyCount: 2, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("from-1");
    expect(await readFile(path.join(destDir2, "b.txt"), "utf8")).toBe("from-2");
  });

  it("returns a no-op result for an empty array of CopyParam objects", () => {
    expect(copyChangedSync([])).toEqual({ copyCount: 0, skipCount: 0 });
  });

  it("ignores an extraneous dest argument when arg1 is clearly a CopyParam array", async () => {
    // Outside the typed API (TS never lets a caller pass both a
    // CopyParam[] and a dest), but if it happens anyway - e.g. from
    // plain JS - the array's own content must win over the stray
    // argument, not the other way around.
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const ignoredDest = path.join(tmpRoot, "should-be-ignored");

    const result = (copyChangedSync as (...args: unknown[]) => unknown)(
      [{ src: "*.txt", dest: destDir, options: { cwd: srcDir, logLevel: "silent" } }],
      ignoredDest,
    );

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("hello");
    await expect(readFile(ignoredDest, "utf8")).rejects.toThrow();
  });
});

describe("copyChangedSync - defaultOptions (CopyParam overload)", () => {
  it("applies defaultOptions to a single CopyParam", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const onCopy = vi.fn();

    const result = copyChangedSync(
      { src: "*.txt", dest: destDir, options: { cwd: srcDir } },
      { logLevel: "silent", onCopy },
    );

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("lets a CopyParam's own options override defaultOptions", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const defaultOnCopyHook = vi.fn();
    const paramOnCopyHook = vi.fn();

    copyChangedSync(
      { src: "*.txt", dest: destDir, options: { cwd: srcDir, onCopy: paramOnCopyHook } },
      { logLevel: "silent", onCopy: defaultOnCopyHook },
    );

    expect(paramOnCopyHook).toHaveBeenCalledTimes(1);
    expect(defaultOnCopyHook).not.toHaveBeenCalled();
  });

  it("applies defaultOptions to every CopyParam in an array", async () => {
    const srcDir2 = path.join(tmpRoot, "src2");
    const destDir2 = path.join(tmpRoot, "dest2");
    await mkdir(srcDir2, { recursive: true });
    await writeFile(path.join(srcDir, "a.txt"), "from-1");
    await writeFile(path.join(srcDir2, "b.txt"), "from-2");
    const onCopy = vi.fn();

    const result = copyChangedSync(
      [
        { src: "*.txt", dest: destDir, options: { cwd: srcDir } },
        { src: "*.txt", dest: destDir2, options: { cwd: srcDir2 } },
      ],
      { logLevel: "silent", onCopy },
    );

    expect(result).toEqual({ copyCount: 2, skipCount: 0 });
    // Regression check: the array-of-CopyParam branch must forward
    // defaultOptions to each recursive call.
    expect(onCopy).toHaveBeenCalledTimes(2);
  });

  it("still returns a no-op for an empty CopyParam[] even with defaultOptions set", () => {
    expect(copyChangedSync([], { logLevel: "silent", force: true })).toEqual({
      copyCount: 0,
      skipCount: 0,
    });
  });
});

describe("copyChangedSync - async hook detection", () => {
  it("warns once, upfront, when a hook is declared with the async keyword", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const logger = createMockLogger();

    const result = copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      logLevel: "silent",
      logger,
      onCheckChanged: async () => false,
    });

    // The async hook's result (false, i.e. "skip") is ignored -
    // copyChangedSync falls back to its normal truthy-checked default
    // and copies the file.
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("onCheckChanged"));
  });

  it("does not warn for a plain synchronous hook", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const logger = createMockLogger();

    copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      logLevel: "silent",
      logger,
      onCheckChanged: () => true,
    });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns only once per call even when many files are copied", async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(path.join(srcDir, `f${i}.txt`), `content-${i}`);
    }
    const logger = createMockLogger();

    const result = copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      logLevel: "silent",
      logger,
      onCheckChanged: async () => true,
    });

    expect(result.copyCount).toBe(5);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("warns separately for each distinct async hook", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const logger = createMockLogger();

    copyChangedSync("*.txt", destDir, {
      cwd: srcDir,
      logLevel: "silent",
      logger,
      onCheckChanged: async () => true,
      onCopy: async () => {},
      onFinish: async () => {},
    });

    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("onCheckChanged"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("onCopy"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("onFinish"));
  });
});
