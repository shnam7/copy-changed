/**
 * Shared helpers for simulating `stat`/`statSync` failures.
 *
 * `stat` (async) and `statSync` are used across index.ts/copyChangedAsync.ts,
 * copyChangedSync.ts, and hooks.ts. A test file that needs to simulate a
 * non-ENOENT error (e.g. EACCES) for one specific path - while every other
 * path still resolves normally - needs its own `vi.mock(...)` call for
 * whichever module it uses, because vitest hoists `vi.mock` calls per-file
 * and the factory can only safely reference state created via
 * `vi.hoisted()` in that same file (a plain shared import doesn't work -
 * the hoisted `vi.mock` call runs before the import binding exists). See a
 * test file below for the ~8 line wiring this requires; the helpers here
 * remove everything else that's actually shareable (getting the real
 * function, and building a targeted override).
 *
 * ```ts
 * import { vi } from "vitest";
 * import type { StatFn } from "./helpers/statMock";
 *
 * const state = vi.hoisted(() => ({ override: null as StatFn | null }));
 * vi.mock("node:fs/promises", async (importOriginal) => {
 *   const actual = await importOriginal<typeof import("node:fs/promises")>();
 *   return {
 *     ...actual,
 *     stat: ((...args: Parameters<StatFn>) =>
 *       state.override ? state.override(...args) : actual.stat(...args)) as StatFn,
 *   };
 * });
 * ```
 *
 * The `statSync` variants below follow the same pattern against
 * `vi.mock("node:fs", ...)` instead.
 */

import type { stat } from "node:fs/promises";
import { vi } from "vitest";

export type StatFn = typeof stat;

/** Returns the real, un-mocked `stat`, for use as a passthrough inside a targeted override. */
export async function getRealStat(): Promise<StatFn> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return actual.stat;
}

/**
 * Builds a `stat` override that throws `error` only when called with
 * `targetPath`, passing every other path through to `realStat`.
 */
export function makeStatErrorOverride(
  targetPath: string,
  error: NodeJS.ErrnoException,
  realStat: StatFn,
): StatFn {
  return (async (target: Parameters<StatFn>[0]) => {
    if (target === targetPath) throw error;
    return realStat(target);
  }) as StatFn;
}

//----- Same pair of helpers for `node:fs`'s synchronous `statSync`, used by
// defaultOnCheckChanged (as opposed to defaultOnCheckChangedAsync, which
// uses `stat` above). Needs its own `vi.mock("node:fs", ...)` in the test
// file, following the same ~8-line wiring pattern shown above.

import type { statSync } from "node:fs";

export type StatSyncFn = typeof statSync;

/** Returns the real, un-mocked `statSync`, for use as a passthrough inside a targeted override. */
export async function getRealStatSync(): Promise<StatSyncFn> {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return actual.statSync;
}

/**
 * Builds a `statSync` override that throws `error` only when called with
 * `targetPath`, passing every other path through to `realStatSync`.
 */
export function makeStatSyncErrorOverride(
  targetPath: string,
  error: NodeJS.ErrnoException,
  realStatSync: StatSyncFn,
): StatSyncFn {
  return ((target: Parameters<StatSyncFn>[0]) => {
    if (target === targetPath) throw error;
    return realStatSync(target);
  }) as StatSyncFn;
}
