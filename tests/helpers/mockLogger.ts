import { vi } from "vitest";

/** A minimal mock satisfying ts-log's `Logger` interface, for asserting on calls directly. */
export const createMockLogger = () => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

// biome-ignore lint: Intentionally matching ANSI escape codes
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
