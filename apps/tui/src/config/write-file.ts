import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

/**
 * Replace `file` with `text` all at once: a reader sees the old content or the new, never part
 * of it. Missing directories are made private (0700), and the file is private (0600) after every
 * write, on POSIX; Windows has no such modes. Throws what the file system threw; no temporary
 * file is left behind either way.
 */
export async function writeFileAtomically(
  file: string,
  text: string,
): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
  const temporary = join(
    dir,
    `.${basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, text, { mode: PRIVATE_FILE });
    // The mode given at creation is narrowed by the umask; this states it exactly.
    if (process.platform !== "win32") await chmod(temporary, PRIVATE_FILE);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The message of whatever was thrown, for a `SaveProblem`'s detail. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
