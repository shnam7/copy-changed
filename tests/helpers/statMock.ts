/**
 * Shared helpers for simulating `node:fs/promises` `stat()` failures.
 *
 * `stat` is used across index.ts, hooks.ts, and utils.ts. A test file that
 * needs to simulate a non-ENOENT `stat` error (e.g. EACCES) for one
 * specific path - while every other path still resolves normally - needs
 * its own `vi.mock("node:fs/promises", ...)` call, because vitest hoists
 * `vi.mock` calls per-file and the factory can only safely reference state
 * created via `vi.hoisted()` in that same file (a plain shared import
 * doesn't work - the hoisted `vi.mock` call runs before the import
 * binding exists). See a test file below for the ~8 line wiring this
 * requires; the two helpers here remove everything else that's actually
 * shareable (getting the real `stat`, and building a targeted override).
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
