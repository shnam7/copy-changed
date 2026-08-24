import { mkdir as mkdirP, writeFile as writeFileP } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirs, removeTempDirs, type TempDirs } from "./helpers/fixtures.ts";
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
  arrayify,
  isAsyncFunction,
  isCopyParam,
  isDirectory,
  isDirectorySync,
  resolveGlobBase,
  stripTrailingSep,
} = await import("../src/utils.ts");

describe("arrayify", () => {
  it("wraps a single value in an array", () => {
    expect(arrayify("a")).toEqual(["a"]);
  });

  it("returns a shallow copy of an array unchanged", () => {
    const input = ["a", "b"];
    const result = arrayify(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });
});

describe("isCopyParam", () => {
  it("returns true for an object with both src and dest", () => {
    expect(isCopyParam({ src: "a", dest: "b" })).toBe(true);
  });

  it.each([
    ["missing dest", { src: "a" }],
    ["missing src", { dest: "b" }],
    ["an array", ["a", "b"]],
    ["null", null],
    ["a string", "a"],
    ["a number", 42],
  ])("returns false for %s", (_label, value) => {
    expect(isCopyParam(value)).toBe(false);
  });
});

describe("isAsyncFunction", () => {
  it("returns true for an async function declaration", () => {
    async function fn() {}
    expect(isAsyncFunction(fn)).toBe(true);
  });

  it("returns true for an async arrow function", () => {
    expect(isAsyncFunction(async () => {})).toBe(true);
  });

  it("returns false for a plain function declaration", () => {
    function fn() {}
    expect(isAsyncFunction(fn)).toBe(false);
  });

  it("returns false for a plain arrow function", () => {
    expect(isAsyncFunction(() => {})).toBe(false);
  });

  it("returns false for a plain function that manually returns a Promise", () => {
    // Documents the known limitation: only the `async` keyword is
    // detected, not a function's actual return value. See the comment on
    // isAsyncFunction in utils.ts and "Sync API hook constraints" in
    // README.md.
    expect(isAsyncFunction(() => Promise.resolve())).toBe(false);
  });

  it.each([
    ["a non-function value", 42],
    ["null", null],
    ["undefined", undefined],
    ["a string", "async"],
  ])("returns false for %s", (_label, value) => {
    expect(isAsyncFunction(value)).toBe(false);
  });
});

describe("stripTrailingSep", () => {
  it("removes a single trailing path separator", () => {
    expect(stripTrailingSep(`a${path.sep}b${path.sep}`)).toBe(`a${path.sep}b`);
  });

  it("leaves a path without a trailing separator unchanged", () => {
    expect(stripTrailingSep(`a${path.sep}b`)).toBe(`a${path.sep}b`);
  });
});

describe("resolveGlobBase", () => {
  it("returns the single parent as-is when there's only one", () => {
    expect(resolveGlobBase(["/a/b"], "/fallback")).toBe("/a/b");
  });

  it("returns the same parent as-is even if repeated", () => {
    expect(resolveGlobBase(["/a/b", "/a/b"], "/fallback")).toBe("/a/b");
  });

  it("finds the common ancestor for parents pointing at sibling subdirectories", () => {
    expect(resolveGlobBase(["/a/dirA", "/a/dirB"], "/fallback")).toBe("/a");
  });

  it("falls back to cwd when parents share no ancestor besides the filesystem root", () => {
    expect(resolveGlobBase(["/a/b", "/c/d"], "/fallback")).toBe("/fallback");
  });
});

describe("isDirectory", () => {
  let dirs: TempDirs;

  afterEach(async () => {
    state.statOverride = null;
    if (dirs) await removeTempDirs(dirs.tmpRoot);
  });

  it("returns true for a path that exists as a real directory", async () => {
    dirs = await createTempDirs();
    expect(await isDirectory(dirs.srcDir)).toBe(true);
  });

  it("returns false for a path that exists as a real file", async () => {
    dirs = await createTempDirs();
    const filePath = path.join(dirs.srcDir, "a.txt");
    await writeFileP(filePath, "hello");
    expect(await isDirectory(filePath)).toBe(false);
  });

  it("guesses directory for a non-existent path with no extension", async () => {
    dirs = await createTempDirs();
    expect(await isDirectory(path.join(dirs.tmpRoot, "brand-new-dir"))).toBe(true);
  });

  it("guesses directory for a non-existent path ending with a separator", async () => {
    dirs = await createTempDirs();
    expect(await isDirectory(path.join(dirs.tmpRoot, "brand-new-dir") + path.sep)).toBe(true);
  });

  it("guesses file for a non-existent path with an extension", async () => {
    dirs = await createTempDirs();
    expect(await isDirectory(path.join(dirs.tmpRoot, "brand-new-file.txt"))).toBe(false);
  });

  it("rethrows a non-ENOENT stat error", async () => {
    dirs = await createTempDirs();
    const target = path.join(dirs.tmpRoot, "unreadable");
    await mkdirP(target);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    state.statOverride = makeStatErrorOverride(target, permissionError, await getRealStat());

    await expect(isDirectory(target)).rejects.toThrow("permission denied");
  });
});

describe("isDirectorySync", () => {
  let dirs: TempDirs;

  afterEach(async () => {
    state.statSyncOverride = null;
    if (dirs) await removeTempDirs(dirs.tmpRoot);
  });

  it("returns true for a path that exists as a real directory", async () => {
    dirs = await createTempDirs();
    expect(isDirectorySync(dirs.srcDir)).toBe(true);
  });

  it("returns false for a path that exists as a real file", async () => {
    dirs = await createTempDirs();
    const filePath = path.join(dirs.srcDir, "a.txt");
    await writeFileP(filePath, "hello");
    expect(isDirectorySync(filePath)).toBe(false);
  });

  it("guesses directory for a non-existent path with no extension", async () => {
    dirs = await createTempDirs();
    expect(isDirectorySync(path.join(dirs.tmpRoot, "brand-new-dir"))).toBe(true);
  });

  it("guesses file for a non-existent path with an extension", async () => {
    dirs = await createTempDirs();
    expect(isDirectorySync(path.join(dirs.tmpRoot, "brand-new-file.txt"))).toBe(false);
  });

  it("rethrows a non-ENOENT stat error", async () => {
    dirs = await createTempDirs();
    const target = path.join(dirs.tmpRoot, "unreadable");
    await mkdirP(target);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    state.statSyncOverride = makeStatSyncErrorOverride(
      target,
      permissionError,
      await getRealStatSync(),
    );

    expect(() => isDirectorySync(target)).toThrow("permission denied");
  });
});
