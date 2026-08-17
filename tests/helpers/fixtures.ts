import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface TempDirs {
  tmpRoot: string;
  srcDir: string;
  destDir: string;
}

/** Creates `tmpRoot/{src,dest}` (only `src` actually exists on disk yet). */
export async function createTempDirs(): Promise<TempDirs> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "copy-changed-"));
  const srcDir = path.join(tmpRoot, "src");
  const destDir = path.join(tmpRoot, "dest");
  await mkdir(srcDir, { recursive: true });
  return { tmpRoot, srcDir, destDir };
}

export async function removeTempDirs(tmpRoot: string): Promise<void> {
  await rm(tmpRoot, { recursive: true, force: true });
}
