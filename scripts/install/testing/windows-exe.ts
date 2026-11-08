/**
 * Real Windows executables for the fake eta-host, compiled from `fake-host-program.ts`.
 *
 * A compiled program is about 100 MB and takes seconds to build, so each variant is built once
 * into the temporary directory, under a name that changes with the source, the variant and the
 * version of Bun; later runs reuse it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const SOURCE = join(import.meta.dir, "fake-host-program.ts");

export type FakeHostMode =
  | "plain"
  | "tamper"
  | "location"
  | "record"
  | "stderr";

export interface FakeHostVariant {
  version: string;
  mode?: FakeHostMode;
}

const built = new Map<string, Promise<string>>();

async function compile(variant: FakeHostVariant, out: string): Promise<void> {
  const partial = `${out}.${process.pid}.partial.exe`;
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "--define",
      `FAKE_VERSION=${JSON.stringify(variant.version)}`,
      "--define",
      `FAKE_MODE=${JSON.stringify(variant.mode ?? "plain")}`,
      SOURCE,
      "--outfile",
      partial,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`bun build --compile failed (${code}): ${stderr}`);
  renameSync(partial, out);
}

/** The path of the compiled fake eta-host for `variant`. */
export async function fakeHostExe(variant: FakeHostVariant): Promise<string> {
  const key = createHash("sha256")
    .update(readFileSync(SOURCE))
    .update(JSON.stringify(variant))
    .update(Bun.version)
    .digest("hex")
    .slice(0, 16);
  const dir = join(tmpdir(), "eta-install-test-exe");
  const out = join(dir, `fake-host-${key}.exe`);
  let pending = built.get(out);
  if (pending === undefined) {
    pending = (async () => {
      mkdirSync(dir, { recursive: true });
      if (!existsSync(out)) await compile(variant, out);
      return out;
    })();
    built.set(out, pending);
  }
  return await pending;
}
