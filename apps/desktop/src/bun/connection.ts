/**
 * Where this window's host is: on this computer, or at an address the user gave.
 *
 * The file belongs to the shell, not to a host: it outlives switching between the two, and a
 * remote host's token sits in it, which is why it is 0600 in a 0700 directory. Nothing here may
 * log the token, and it never goes to a page: the page gets a cookie for it from the host.
 *
 * A file that cannot be read is the same as no file: the window asks again rather than guessing.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

export type Connection =
  | { mode: "local" }
  | {
      mode: "remote";
      /** An origin: `hostOrigin` made it. */
      address: string;
      /** Empty when the host has no token gate. */
      token: string;
    };

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/**
 * What a typed or linked address means: the origin the window will load. No scheme means `http`,
 * as on the phone. A path says nothing, because a host serves from its root.
 */
export function hostOrigin(address: string): string | undefined {
  const trimmed = address.trim();
  if (trimmed === "") return undefined;
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`,
    );
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function parseConnection(text: string): Connection | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { address, mode, token } = value as Record<string, unknown>;
  if (mode === "local") return { mode };
  if (mode !== "remote" || typeof address !== "string") return undefined;
  const origin = hostOrigin(address);
  return origin === undefined || typeof token !== "string"
    ? undefined
    : { mode, address: origin, token };
}

export async function readConnection(
  file: string,
): Promise<Connection | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  // Copied from a backup or edited by hand, it may have come back readable by others.
  await chmod(file, FILE_MODE);
  return parseConnection(text);
}

/**
 * Written beside the file and renamed over it: a crash leaves the old choice, and a token is never
 * in a file with the old file's permissions.
 */
export async function writeConnection(
  file: string,
  connection: Connection,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: DIRECTORY_MODE });
  const temporary = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(connection, null, 2)}\n`, {
    mode: FILE_MODE,
  });
  await rename(temporary, file);
}
