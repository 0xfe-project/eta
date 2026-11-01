/**
 * Where the host's own files are: in the checkout, or beside the executable.
 *
 * Run from source, a file the host reads (the migrations, the built-in bundles, the mail logo) is
 * where the checkout keeps it, found from the module that reads it. A `bun build --compile` host
 * has no checkout: its modules live in the executable's virtual filesystem (`/$bunfs/root`), and
 * the files travel beside it instead — `apps/desktop/scripts/stage-host.ts` lays them out, flat,
 * in the executable's directory. The name passed here is the name in that directory.
 */
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** A compiled binary is its own program; run from source the program is bun. */
export const COMPILED = !basename(process.execPath).startsWith("bun");

/** `name` in the executable's directory: only meaningful for a compiled host. */
export function besideExecutable(name: string): string {
  return join(dirname(process.execPath), name);
}

/** `name` beside the executable when compiled, else the checkout's file at `checkout`. */
export function resourcePath(name: string, checkout: URL): string {
  return COMPILED ? besideExecutable(name) : fileURLToPath(checkout);
}
