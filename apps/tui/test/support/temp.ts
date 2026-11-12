/** Temporary directories that every test here cleans up after itself. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // A child process that just ended may still hold a file for a moment on Windows.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
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
