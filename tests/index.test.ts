import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
// NOTE: the implementation resolves each matched file's stat via a path
// that is only correct when `process.cwd()` matches the `cwd` option (or
// the `cwd` option is omitted). All tests below therefore run with the
// process cwd switched to the directory under test.

let originalCwd: string;
let tmpRoot: string;
let srcDir: string;
let destDir: string;
let relDest: string; // relative path to destination.

function readDest(pathName: string) {
  return readFile(path.join(relDest, pathName), "utf8");
}

beforeEach(async () => {
  originalCwd = process.cwd();

  // tmpRoot = await mkdtemp(path.join(os.tmpdir(), "copy-changed-"));
  // tmpRoot = path.join(import.meta.dirname, "data");
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "copy-changed-"));
  srcDir = "src";
  destDir = "dest";
  relDest = path.relative(srcDir, destDir);

  await mkdir(path.join(tmpRoot, srcDir), { recursive: true });
  process.chdir(path.join(tmpRoot, srcDir));
  // console.log(`=====5: cwd=${process.cwd()}`);
  // console.log(`=====5: srcDir='${srcDir}' destDir='${destDir}' relDeat='${relDest}'`);
});

afterEach(async () => {
  process.chdir(originalCwd);
  statOverride = null;
  vi.restoreAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("copyChanged", () => {
  it("copies files that do not yet exist in dest", async () => {
    await writeFile("a.txt", "hello");
    const result = await copyChanged("*.txt", relDest, { logLevel: "silent" });

    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
    const copied = await readDest("a.txt");
    expect(copied).toBe("hello");
  });

  it("copies files inside nested directories preserving structure", async () => {
    await mkdir(path.join("nested", "deep"), { recursive: true });
    await writeFile(path.join("nested", "deep", "b.txt"), "nested-content");
    const result = await copyChanged("**/*.txt", relDest, { logLevel: "silent" });
    expect(result.copyCount).toBe(1);
    const copied = await readDest(path.join("nested", "deep", "b.txt"));
    expect(copied).toBe("nested-content");
  });

  it("skips files that are unchanged on a second run", async () => {
    await writeFile("a.txt", "hello");

    const first = await copyChanged("*.txt", relDest, { logLevel: "silent" });
    expect(first).toEqual({ copyCount: 1, skipCount: 0 });

    const second = await copyChanged("*.txt", relDest, { logLevel: "silent" });
    expect(second).toEqual({ copyCount: 0, skipCount: 1 });
  });

  it("re-copies a file whose size changed even if mtime looks older", async () => {
    await writeFile("a.txt", "hello");
    await copyChanged("*.txt", relDest, { logLevel: "silent" });

    // Make the dest file look newer than src, but give it a different size.
    const destPath = path.join(relDest, "a.txt");
    const future = new Date(Date.now() + 10_000);
    await writeFile(destPath, "a-completely-different-length-of-content");
    await utimes(destPath, future, future);

    const result = await copyChanged("*.txt", relDest, { logLevel: "silent" });
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("re-copies a file whose mtime changed even if size is identical", async () => {
    await writeFile("a.txt", "hello");
    await copyChanged("*.txt", relDest, { logLevel: "silent" });

    // Touch the source so it looks newer than dest, keep the same length.
    const srcPath = "./a.txt";
    const future = new Date(Date.now() + 10_000);
    await utimes(srcPath, future, future);

    const result = await copyChanged("*.txt", relDest, { logLevel: "silent" });
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("force option always copies regardless of change detection", async () => {
    await writeFile("a.txt", "hello");
    await copyChanged("*.txt", relDest, { logLevel: "silent" });

    const result = await copyChanged("*.txt", relDest, {
      force: true,
      logLevel: "silent",
    });
    expect(result).toEqual({ copyCount: 1, skipCount: 0 });
  });

  it("clearDest=true removes all existing files in dest before copying", async () => {
    // del's own safety check refuses to delete anything outside process.cwd(),
    // so these use a dest directory nested inside srcDir (which is also
    // process.cwd() for the duration of the test, see beforeEach).
    const nestedDest = "out";
    await writeFile("a.txt", "hello");
    await mkdir(nestedDest, { recursive: true });
    await writeFile(path.join(nestedDest, "stray.txt"), "should be removed");

    const result = await copyChanged("*.txt", nestedDest, {
      clearDest: true,
      logLevel: "silent",
    });

    expect(result.copyCount).toBe(1);
    await expect(readDest(path.join(nestedDest, "stray.txt"))).rejects.toThrow();
  });

  it("clearDest with a single glob string deletes only matching files", async () => {
    // del's own safety check refuses to delete anything outside process.cwd(),
    // so these use a dest directory nested inside srcDir (which is also
    // process.cwd() for the duration of the test, see beforeEach).

    const nestedDest = "out";
    await writeFile("a.txt", "hello");
    await mkdir(nestedDest, { recursive: true });
    await writeFile(path.join(nestedDest, "old.txt"), "old");
    await writeFile(path.join(nestedDest, "keep.json"), "{}");

    await copyChanged("*.txt", nestedDest, {
      clearDest: "*.txt",
      logLevel: "silent",
    });

    await expect(readFile(path.join(nestedDest, "old.txt"), "utf-8")).rejects.toThrow();
    const kept = await readFile(path.join(nestedDest, "keep.json"), "utf-8");
    expect(kept).toBe("{}");
  });

  it("clearDest with an array including a negated pattern runs without error", async () => {
    // del's own safety check refuses to delete anything outside process.cwd(),
    // so these use a dest directory nested inside srcDir (which is also
    // process.cwd() for the duration of the test, see beforeEach).

    const nestedDest = "out";
    await writeFile("a.txt", "hello");
    await mkdir(nestedDest, { recursive: true });
    await writeFile(path.join(nestedDest, "old.txt"), "old");
    await writeFile(path.join(nestedDest, "keep.txt"), "keep me");

    const result = await copyChanged("*.txt", nestedDest, {
      clearDest: ["*.txt", "!keep.txt"],
      logLevel: "silent",
    });

    expect(result.copyCount).toBe(1);
  });

  it("logs a verbose message when emptying the dest directory", async () => {
    // del's own safety check refuses to delete anything outside process.cwd(),
    // so these use a dest directory nested inside srcDir (which is also
    // process.cwd() for the duration of the test, see beforeEach).

    const nestedDest = "out";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await writeFile("a.txt", "hello");
    await mkdir(nestedDest, { recursive: true });

    await copyChanged("*.txt", nestedDest, {
      clearDest: true,
      logLevel: "verbose",
    });

    const messages = logSpy.mock.calls.map((call) => call.join(" "));
    expect(messages.some((m) => m.includes("target directory cleaned"))).toBe(true);
  });

  it("logs verbose copy and skip messages", async () => {
    await writeFile("a.txt", "hello");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await copyChanged("*.txt", relDest, { logLevel: "verbose" });
    let messages = logSpy.mock.calls.map((call) => call.join(" "));
    expect(messages.some((m) => m.includes("a.txt -> "))).toBe(true);

    logSpy.mockClear();
    await copyChanged("*.txt", relDest, { logLevel: "verbose" });
    messages = logSpy.mock.calls.map((call) => call.join(" "));
    expect(messages.some((m) => m.startsWith("[SKIP]"))).toBe(true);
  });

  it("prints a summary line by default (normal log level)", async () => {
    await writeFile("a.txt", "hello");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await copyChanged("*.txt", relDest);

    const messages = logSpy.mock.calls.map((call) => call.join(" "));
    expect(messages.some((m) => m.includes("1 file(s) copied"))).toBe(true);
  });

  it("suppresses the summary line when logLevel is silent", async () => {
    await writeFile("a.txt", "hello");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await copyChanged("*.txt", relDest, { logLevel: "silent" });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("copies a single named file into an existing destination file's directory", async () => {
    // This case needs cwd to be tmpRoot (the parent of both src and dest),
    // and a src path expressed relative to that cwd.
    process.chdir(tmpRoot);

    await writeFile(path.join(srcDir, "single.txt"), "single-content");
    const srcFile = path.join(srcDir, "single.txt");

    // Pre-create dest as a file (not a directory).
    await mkdir(destDir, { recursive: true });
    const destFile = path.join(destDir, "placeholder.txt");
    await writeFile(destFile, "placeholder");

    const result = await copyChanged(srcFile, destFile, {
      cwd: tmpRoot,
      logLevel: "silent",
    });

    expect(result.copyCount).toBe(1);
    const copied = await readFile(path.join(destDir, "placeholder.txt"), "utf8");
    expect(copied).toBe("single-content");
  });

  it("throws when dest is an existing file but src is a glob pattern", async () => {
    await writeFile("a.txt", "hello");
    await mkdir(relDest, { recursive: true });
    const destFile = path.join(relDest, "placeholder.txt");
    await writeFile(destFile, "placeholder");

    await expect(copyChanged("*.txt", destFile, { logLevel: "silent" })).rejects.toThrow(
      /Glob pattern cannot be copied to file/,
    );
  });

  it("uses process.cwd() when no cwd option is supplied", async () => {
    // beforeEach already chdir'd into srcDir.
    await writeFile("a.txt", "hello");

    const result = await copyChanged("*.txt", destDir, { logLevel: "silent" });
    expect(result.copyCount).toBe(1);
  });

  it("rethrows a non-ENOENT error from the initial dest stat check", async () => {
    await writeFile("a.txt", "hello");

    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    statOverride = (async (target: Parameters<StatFn>[0]) => {
      // console.log(`=====555: ${target} ${relDest}`);
      if (target === relDest) throw permissionError;
      return realStat(target);
    }) as StatFn;

    await expect(copyChanged("*.txt", relDest, { logLevel: "silent" })).rejects.toThrow(
      "permission denied",
    );
  });

  it("rethrows a non-ENOENT error from the per-file dest stat check", async () => {
    await writeFile("a.txt", "hello");
    await mkdir(relDest, { recursive: true });

    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const destFilePath = path.join(relDest, "a.txt");
    statOverride = (async (target: Parameters<StatFn>[0]) => {
      if (target === destFilePath) throw permissionError;
      return realStat(target);
    }) as StatFn;

    await expect(copyChanged("*.txt", relDest, { logLevel: "silent" })).rejects.toThrow(
      "permission denied",
    );
  });

  it("supports an array of glob patterns including negative patterns", async () => {
    const nestedSrc = "deep";
    await mkdir(nestedSrc, { recursive: true });

    await writeFile(path.join(nestedSrc, "index.html"), "<html></html>");
    await writeFile(path.join(nestedSrc, "main.ts"), "console.log('main');");
    await writeFile(path.join(nestedSrc, "style.css"), "body {}");

    const srcGlob = ["**", "!**/index.html"];
    const result = await copyChanged(srcGlob, relDest, { logLevel: "silent" });
    expect(result).toEqual({ copyCount: 2, skipCount: 0 });

    const copiedTs = await readDest("deep/main.ts");
    const copiedCss = await readDest("deep/style.css");

    expect(copiedTs).toBe("console.log('main');");
    expect(copiedCss).toBe("body {}");
    await expect(readDest("deep/index.html")).rejects.toThrow();
  });
});
