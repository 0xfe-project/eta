/** Temporary directories that every test here cleans up after itself. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach } from "vitest";

const roots: string[] = [];

/** Bun's `rm` ignores `maxRetries` on Windows EBUSY, so retry brief locks explicitly. */
export async function removeWithRetry(path: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") ||
        attempt >= 20
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await removeWithRetry(root);
});

/** A fresh empty directory, removed after the test. */
export async function tempDir(prefix = "eta-tui-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Waits until `predicate` holds, polling; throws after `timeoutMs`. */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  what = "the condition",
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
