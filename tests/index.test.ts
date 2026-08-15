import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Controllable stat mock -------------------------------------------
// We keep the real implementation by default, but allow individual tests
// to inject a custom `stat` behavior (e.g. to simulate a permission error)
// for a specific path while every other path still resolves normally.
type StatFn = typeof import("node:fs/promises").stat;
let statOverride: StatFn | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: ((...args: Parameters<StatFn>) => {
      if (statOverride) return statOverride(...args);
      return actual.stat(...args);
    }) as StatFn,
  };
});

// A reference to the real, un-mocked `stat`, used as a passthrough inside
// the per-test overrides below so they don't recurse into themselves.
const { stat: realStat } =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

const { copyChanged } = await import("../src/index.ts");

// -------------------------------------------------------------------------

let tmpRoot: string;
let srcDir: string;
let destDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "copy-changed-"));
  srcDir = path.join(tmpRoot, "src");
  destDir = path.join(tmpRoot, "dest");
  await mkdir(srcDir, { recursive: true });
});

afterEach(async () => {
  statOverride = null;
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("copyChanged - core behavior", () => {
  it("copies files that do not yet exist in dest", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");

    const result = await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("hello");
  });

  it("copies files inside nested directories preserving structure", async () => {
    await mkdir(path.join(srcDir, "nested", "deep"), { recursive: true });
    await writeFile(path.join(srcDir, "nested", "deep", "b.txt"), "nested-content");

    const result = await copyChanged("**/*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    expect(result.copyCount).toBe(1);
    expect(await readFile(path.join(destDir, "nested", "deep", "b.txt"), "utf8")).toBe(
      "nested-content",
    );
  });

  it("accepts an array of glob patterns", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "top-level");
    await mkdir(path.join(srcDir, "other"), { recursive: true });
    await writeFile(path.join(srcDir, "other", "b.txt"), "in-subdir");

    const result = await copyChanged(["*.txt", "other/*.txt"], destDir, {
      cwd: srcDir,
      logLevel: "silent",
    });

    expect(result).toEqual({ copyCount: 2, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("top-level");
    expect(await readFile(path.join(destDir, "other", "b.txt"), "utf8")).toBe("in-subdir");
  });

  it("falls back to cwd as the glob base when patterns share no common ancestor", async () => {
    const result = await copyChanged(
      ["/copy-changed-root-a/*.txt", "/copy-changed-root-b/*.txt"],
      destDir,
      { cwd: srcDir, logLevel: "silent" },
    );

    expect(result).toEqual({ copyCount: 0, skipCount: 0 });
  });

  it("returns a no-op result for an empty src array (absorbed by the CopyParam[] branch)", async () => {
    const result = await copyChanged([], destDir, { cwd: srcDir, logLevel: "silent" });
    expect(result).toEqual({ copyCount: 0, skipCount: 0 });
  });

  it("returns a no-op result when src patterns are empty strings (delegated to tinyglobby)", async () => {
    const result = await copyChanged([""], destDir, { cwd: srcDir, logLevel: "silent" });
    expect(result).toEqual({ copyCount: 0, skipCount: 0 });
  });

  it("skips files that are unchanged on a second run", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");

    const first = await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });
    expect(first).toEqual({ copyCount: 1, skipCount: 0 });

    const second = await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });
    expect(second).toEqual({ copyCount: 0, skipCount: 1 });
  });

  it("re-copies a file whose size changed even if mtime looks older", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    const destPath = path.join(destDir, "a.txt");
    const future = new Date(Date.now() + 10_000);
    await writeFile(destPath, "a-completely-different-length-of-content");
    await utimes(destPath, future, future);

    const result = await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("re-copies a file whose mtime changed even if size is identical", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    const srcPath = path.join(srcDir, "a.txt");
    const future = new Date(Date.now() + 10_000);
    await utimes(srcPath, future, future);

    const result = await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("force option always copies regardless of change detection", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    const result = await copyChanged("*.txt", destDir, {
      cwd: srcDir,
      force: true,
      logLevel: "silent",
    });
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("copies a single named file to an explicit destination file path", async () => {
    await writeFile(path.join(srcDir, "single.txt"), "single-content");
    const destFile = path.join(destDir, "renamed.txt");

    const result = await copyChanged("single.txt", destFile, { cwd: srcDir, logLevel: "silent" });

    expect(result.copyCount).toBe(1);
    expect(await readFile(destFile, "utf8")).toBe("single-content");
  });

  it("copies a single named file into an existing destination file's directory", async () => {
    await writeFile(path.join(srcDir, "single.txt"), "single-content");
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, "placeholder.txt");
    await writeFile(destFile, "placeholder");

    const result = await copyChanged("single.txt", destFile, { cwd: srcDir, logLevel: "silent" });

    expect(result.copyCount).toBe(1);
    expect(await readFile(destFile, "utf8")).toBe("single-content");
  });

  it("throws when dest is an existing file but src is a glob pattern", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, "placeholder.txt");
    await writeFile(destFile, "placeholder");

    await expect(
      copyChanged("*.txt", destFile, { cwd: srcDir, logLevel: "silent" }),
    ).rejects.toThrow(/Glob pattern cannot be copied to file/);
  });

  it("throws when dest is an existing file but src is an array with more than one pattern", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await writeFile(path.join(srcDir, "b.txt"), "world");
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, "placeholder.txt");
    await writeFile(destFile, "placeholder");

    await expect(
      copyChanged(["a.txt", "b.txt"], destFile, { cwd: srcDir, logLevel: "silent" }),
    ).rejects.toThrow(/Glob pattern cannot be copied to file/);
  });

  it("treats a non-existent dest without an extension as a directory", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const freshDest = path.join(tmpRoot, "brand-new-dir");

    const result = await copyChanged("*.txt", freshDest, { cwd: srcDir, logLevel: "silent" });

    expect(result.copyCount).toBe(1);
    expect(await readFile(path.join(freshDest, "a.txt"), "utf8")).toBe("hello");
  });

  it("uses process.cwd() when no cwd option is supplied", async () => {
    const originalCwd = process.cwd();
    process.chdir(srcDir);
    try {
      await writeFile(path.join(srcDir, "a.txt"), "hello");
      const result = await copyChanged("*.txt", destDir, { logLevel: "silent" });
      expect(result.copyCount).toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not mutate process.cwd() and supports concurrent calls with different cwd options", async () => {
    const originalCwd = process.cwd();
    const srcDir2 = path.join(tmpRoot, "src2");
    const destDir2 = path.join(tmpRoot, "dest2");
    await mkdir(srcDir2, { recursive: true });
    await writeFile(path.join(srcDir, "a.txt"), "from-1");
    await writeFile(path.join(srcDir2, "b.txt"), "from-2");

    const [result1, result2] = await Promise.all([
      copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" }),
      copyChanged("*.txt", destDir2, { cwd: srcDir2, logLevel: "silent" }),
    ]);

    expect(result1).toEqual({ copyCount: 1, skipCount: 0 });
    expect(result2).toEqual({ copyCount: 1, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("from-1");
    expect(await readFile(path.join(destDir2, "b.txt"), "utf8")).toBe("from-2");
    expect(process.cwd()).toBe(originalCwd);
  });

  it("rethrows a non-ENOENT error from the per-file stat check", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });

    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const destFilePath = path.join(destDir, "a.txt");
    statOverride = (async (target: Parameters<StatFn>[0]) => {
      if (target === destFilePath) throw permissionError;
      return realStat(target);
    }) as StatFn;

    await expect(
      copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" }),
    ).rejects.toThrow("permission denied");
  });

  it("rethrows a non-ENOENT error from the initial dest-directory check", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const freshDest = path.join(tmpRoot, "brand-new-dir");

    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    statOverride = (async (target: Parameters<StatFn>[0]) => {
      if (target === freshDest) throw permissionError;
      return realStat(target);
    }) as StatFn;

    await expect(
      copyChanged("*.txt", freshDest, { cwd: srcDir, logLevel: "silent" }),
    ).rejects.toThrow("permission denied");
  });
});

describe("copyChanged - clearDest", () => {
  it("clearDest=true removes all existing files in dest before copying", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, "stray.txt"), "should be removed");

    const result = await copyChanged("*.txt", destDir, {
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

    await copyChanged("*.txt", destDir, { cwd: srcDir, clearDest: "*.txt", logLevel: "silent" });

    await expect(readFile(path.join(destDir, "old.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(destDir, "keep.json"), "utf8")).toBe("{}");
  });

  it("clearDest with an array including a negated pattern runs without error", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, "old.txt"), "old");
    await writeFile(path.join(destDir, "keep.txt"), "keep me");

    const result = await copyChanged("*.txt", destDir, {
      cwd: srcDir,
      clearDest: ["*.txt", "!keep.txt"],
      logLevel: "silent",
    });

    expect(result.copyCount).toBe(1);
  });

  it("logs a verbose message when clearing the dest directory", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });

    await copyChanged("*.txt", destDir, { cwd: srcDir, clearDest: true, logLevel: "verbose" });

    const messages = logSpy.mock.calls.map((call) => call.join(" "));
    expect(messages.some((m) => m.includes("cleaned") && m.includes(path.join(destDir, "*")))).toBe(
      true,
    );
  });

  it("calls onClearDest with the delete patterns for a directory dest", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, "stray.txt"), "should be removed");
    const onClearDest = vi.fn();

    await copyChanged("*.txt", destDir, {
      cwd: srcDir,
      clearDest: true,
      logLevel: "silent",
      onClearDest,
    });

    expect(onClearDest).toHaveBeenCalledTimes(1);
    expect(onClearDest).toHaveBeenCalledWith([path.join(destDir, "*")], expect.anything());
  });

  it("actually deletes the dest file when clearDest is set for a single-file dest", async () => {
    await writeFile(path.join(srcDir, "single.txt"), "new-content");
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, "out.txt");
    await writeFile(destFile, "old-content-that-is-much-longer-than-new");

    const result = await copyChanged("single.txt", destFile, {
      cwd: srcDir,
      clearDest: true,
      logLevel: "silent",
    });

    // The dest file existed before, with stale content; clearDest should
    // have removed it (and copyChanged then re-creates it from src).
    expect(result.copyCount).toBe(1);
    expect(await readFile(destFile, "utf8")).toBe("new-content");
  });

  it("removes a single-file dest with no replacement when src does not match", async () => {
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, "out.txt");
    await writeFile(destFile, "will be deleted");

    // "missing.txt" does not exist in srcDir, so nothing will be copied
    // back - this documents clearDest's current "delete first" behavior.
    const result = await copyChanged("missing.txt", destFile, {
      cwd: srcDir,
      clearDest: true,
      logLevel: "silent",
    });

    expect(result).toEqual({ copyCount: 0, skipCount: 0 });
    await expect(readFile(destFile, "utf8")).rejects.toThrow();
  });

  it("logs a verbose message when clearing a single-file dest", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await writeFile(path.join(srcDir, "single.txt"), "content");
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, "out.txt");
    await writeFile(destFile, "placeholder");

    await copyChanged("single.txt", destFile, {
      cwd: srcDir,
      clearDest: true,
      logLevel: "verbose",
    });

    const messages = logSpy.mock.calls.map((call) => call.join(" "));
    expect(messages.some((m) => m.includes("cleaned") && m.includes(destFile))).toBe(true);
  });

  it("calls onClearDest with the deleted path for a single-file dest", async () => {
    await writeFile(path.join(srcDir, "single.txt"), "content");
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, "out.txt");
    await writeFile(destFile, "placeholder");
    const onClearDest = vi.fn();

    await copyChanged("single.txt", destFile, {
      cwd: srcDir,
      clearDest: true,
      logLevel: "silent",
      onClearDest,
    });

    expect(onClearDest).toHaveBeenCalledTimes(1);
    expect(onClearDest).toHaveBeenCalledWith([destFile], expect.anything());
  });
});

describe("copyChanged - logging", () => {
  it("logs verbose copy and skip messages", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "verbose" });
    let messages = logSpy.mock.calls.map((call) => call.join(" "));
    expect(messages.some((m) => m.includes("Copy: ") && m.includes("a.txt"))).toBe(true);

    logSpy.mockClear();
    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "verbose" });
    messages = logSpy.mock.calls.map((call) => call.join(" "));
    expect(messages.some((m) => m.includes("Skip: "))).toBe(true);
  });

  it("prints a summary line by default (normal log level)", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await copyChanged("*.txt", destDir, { cwd: srcDir });

    const messages = logSpy.mock.calls.map((call) => call.join(" "));
    expect(messages.some((m) => m.includes("1 file(s) copied"))).toBe(true);
  });

  it("suppresses the summary line when logLevel is silent", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("copyChanged - globOptions", () => {
  it("forwards globOptions to tinyglobby (e.g. an ignore pattern)", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "keep");
    await writeFile(path.join(srcDir, "b.txt"), "ignored");

    const result = await copyChanged("*.txt", destDir, {
      cwd: srcDir,
      logLevel: "silent",
      globOptions: { ignore: ["b.txt"] },
    });

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("keep");
    await expect(readFile(path.join(destDir, "b.txt"), "utf8")).rejects.toThrow();
  });

  it("cwd option always wins over a cwd set inside globOptions", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "from-real-cwd");

    const result = await copyChanged("*.txt", destDir, {
      cwd: srcDir,
      logLevel: "silent",
      // Deliberately conflicting with the top-level cwd - the top-level
      // `cwd` option must win.
      globOptions: { cwd: "/some/other/unrelated/path" },
    });

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });
});

describe("copyChanged - event handlers", () => {
  it("calls onCopy and onSkip with the resolved src/dest paths", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const onCopy = vi.fn();
    const onSkip = vi.fn();

    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent", onCopy, onSkip });
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith(
      path.join(srcDir, "a.txt"),
      path.join(destDir, "a.txt"),
      expect.anything(),
    );
    expect(onSkip).not.toHaveBeenCalled();

    onCopy.mockClear();
    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent", onCopy, onSkip });
    expect(onCopy).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("awaits an async onCopy/onSkip handler before continuing", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const order: string[] = [];
    const onCopy = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("onCopy");
    });

    const result = await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent", onCopy });
    order.push("done");

    expect(result.copyCount).toBe(1);
    expect(order).toEqual(["onCopy", "done"]);
  });

  it("lets onCheckChanged fully override the default change-detection logic", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent" });

    // File is unchanged by the default mtime/size comparison (would be
    // skipped) - but the default comparison never runs at all once a
    // custom handler is supplied, so returning `true` here forces a copy.
    const onCheckChanged = vi.fn((_srcFile: string, _destFile: string) => true);
    const result = await copyChanged("*.txt", destDir, {
      cwd: srcDir,
      logLevel: "silent",
      onCheckChanged,
    });

    expect(onCheckChanged).toHaveBeenCalledTimes(1);
    expect(onCheckChanged).toHaveBeenCalledWith(
      path.join(srcDir, "a.txt"),
      path.join(destDir, "a.txt"),
      expect.anything(),
    );
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("supports an async onCheckChanged handler that re-implements the default logic", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");

    // Dest doesn't exist yet, so a from-scratch comparison should copy it -
    // this exercises both the async path and that the handler is fully
    // responsible for its own "missing dest" handling.
    const onCheckChanged = vi.fn(async (srcFile: string, destFile: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        const [srcStat, destStat] = await Promise.all([stat(srcFile), stat(destFile)]);
        return srcStat.mtimeMs > destStat.mtimeMs || srcStat.size !== destStat.size;
      } catch {
        return true;
      }
    });

    const result = await copyChanged("*.txt", destDir, {
      cwd: srcDir,
      logLevel: "silent",
      onCheckChanged,
    });

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("does not call onCheckChanged when force is true", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const onCheckChanged = vi.fn(() => false);

    const result = await copyChanged("*.txt", destDir, {
      cwd: srcDir,
      force: true,
      logLevel: "silent",
      onCheckChanged,
    });

    expect(onCheckChanged).not.toHaveBeenCalled();
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("calls onFinish with the final result even when logLevel is silent", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const onFinish = vi.fn();

    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent", onFinish });

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith({ copyCount: 1, skipCount: 0 }, expect.anything());
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("awaits an async onFinish handler before returning", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");
    let finished = false;
    const onFinish = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });

    await copyChanged("*.txt", destDir, { cwd: srcDir, logLevel: "silent", onFinish });

    expect(finished).toBe(true);
  });
});

describe("copyChanged - CopyParam overload", () => {
  it("accepts a single CopyParam object", async () => {
    await writeFile(path.join(srcDir, "a.txt"), "hello");

    const result = await copyChanged({
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

    const result = await copyChanged([
      { src: "*.txt", dest: destDir, options: { cwd: srcDir, logLevel: "silent" } },
      { src: "*.txt", dest: destDir2, options: { cwd: srcDir2, logLevel: "silent" } },
    ]);

    expect(result).toEqual({ copyCount: 2, skipCount: 0 });
    expect(await readFile(path.join(destDir, "a.txt"), "utf8")).toBe("from-1");
    expect(await readFile(path.join(destDir2, "b.txt"), "utf8")).toBe("from-2");
  });

  it("returns a no-op result for an empty array of CopyParam objects", async () => {
    const result = await copyChanged([]);
    expect(result).toEqual({ copyCount: 0, skipCount: 0 });
  });
});
