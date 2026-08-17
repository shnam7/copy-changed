import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirs, removeTempDirs, type TempDirs } from "./helpers/fixtures.ts";
import { getRealStat, makeStatErrorOverride, type StatFn } from "./helpers/statMock.ts";

const state = vi.hoisted(() => ({ override: null as StatFn | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: ((...args: Parameters<StatFn>) =>
      state.override ? state.override(...args) : actual.stat(...args)) as StatFn,
  };
});

const { arrayify, isCopyParam, isDirectory, resolveGlobBase, stripTrailingSep } = await import(
  "../src/utils.ts"
);

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
    state.override = null;
    if (dirs) await removeTempDirs(dirs.tmpRoot);
  });

  it("returns true for a path that exists as a real directory", async () => {
    dirs = await createTempDirs();
    expect(await isDirectory(dirs.srcDir)).toBe(true);
  });

  it("returns false for a path that exists as a real file", async () => {
    dirs = await createTempDirs();
    const filePath = path.join(dirs.srcDir, "a.txt");
    await writeFile(filePath, "hello");
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
    await mkdir(target);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    state.override = makeStatErrorOverride(target, permissionError, await getRealStat());

    await expect(isDirectory(target)).rejects.toThrow("permission denied");
  });
});
