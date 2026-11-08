/**
 * The host's own files: in the checkout, or inside the executable.
 *
 * Run from source, a file the host reads (the migrations, the mail logo) is where the checkout
 * keeps it. A `bun build --compile` host has no checkout: `apps/eta/scripts/build-host.ts`
 * compiles it from a generated entry (`apps/eta/scripts/embed.ts`) that imports every file with
 * `{ type: "file" }` and hands the table over with `embedResources` before the host starts. A
 * name here is the file's name in that table, `migrations/0001-agents.sql`; what the bundler made
 * of it (`/$bunfs/root/0001-agents-n93k08rt.sql`) is its business.
 *
 * Embedded files can be read, not run, and not opened with `node:fs` streams: `Bun.file` and
 * `readFileSync` work, `createReadStream` does not. What has to run is unpacked on first use, by
 * `unpack`, to a directory named after its content under `<dataDir>/unpacked`.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createZstdDecompress } from "node:zlib";

/** A compiled binary is its own program; run from source the program is bun. */
export const COMPILED = !basename(process.execPath).startsWith("bun");

/** What the generated module of a compiled host hands over. */
export interface Embedded {
  /** Each file's original name, and the path it has in the executable. */
  files: Readonly<Record<string, string>>;
  /** For each directory that gets unpacked, a hash of what is in it. */
  digests: Readonly<Record<string, string>>;
}

/** Where a checkout keeps the files every host reads, by the first segment of their names. */
const CHECKOUT: Readonly<Record<string, URL>> = {
  migrations: new URL("migrations/", import.meta.url),
  "Eta-Logo.png": new URL("../../web/public/Eta-Logo.png", import.meta.url),
};

/** Set once, before anything reads a resource; a test puts it back with `undefined`. */
let embedded: Embedded | undefined;

export function embedResources(table: Embedded | undefined): void {
  embedded = table;
}

/** A path `Bun.file` and `readFileSync` can read `name` from. */
export function resource(name: string): string {
  if (embedded === undefined) return checkoutPath(name);
  const path = embedded.files[name];
  if (path === undefined) throw new Error(`no resource named ${name}`);
  return path;
}

/** The names of the files in `dir`, sorted. */
export function resourceNames(dir: string): string[] {
  const files =
    embedded === undefined
      ? readdirSync(checkoutPath(dir))
      : Object.keys(embeddedFiles(dir) ?? {});
  return files.map((file) => `${dir}/${file}`).sort();
}

/**
 * The files the executable carries under `dir`, by their paths inside it, with where each one is.
 * Undefined when run from source, where the page and the daemons are not resources: `--web-dir`
 * names the page and the daemons are the checkout's builds.
 */
export function embeddedFiles(
  dir: string,
): Readonly<Record<string, string>> | undefined {
  if (embedded === undefined) return undefined;
  const prefix = `${dir}/`;
  return Object.fromEntries(
    Object.entries(embedded.files)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, path]) => [name.slice(prefix.length), path]),
  );
}

function checkoutPath(name: string): string {
  const [top = name, ...rest] = name.split("/");
  const base = CHECKOUT[top];
  if (base === undefined) throw new Error(`no resource named ${name}`);
  return join(fileURLToPath(base), ...rest);
}

/** The unpacking in progress in this process, so two callers share one write. */
const unpacking = new Map<string, Promise<string>>();

/**
 * An embedded file as a real one, written the first time it is needed, and the path to it.
 * `<dir>/<file>` lands in `<dataDir>/unpacked/<dir>-<digest>/`, without the `.zst` of a compressed
 * one. The directory is named after the content, so another build of the host has one of its
 * own, and it is the one left: the others under `<dir>-` go. Deleted, it is simply written again.
 *
 * Hosts may start together on one data directory: each writes a file of its own and renames it
 * into place, so the name only ever holds a whole file. `expected` is what a compressed file comes
 * to, and what any file must be for this to go on.
 */
export function unpack(
  dataDir: string,
  name: string,
  expected?: { size: number; sha256: string },
): Promise<string> {
  const key = `${dataDir}\0${name}`;
  let running = unpacking.get(key);
  if (running === undefined) {
    running = write(dataDir, name, expected).finally(() =>
      unpacking.delete(key),
    );
    unpacking.set(key, running);
  }
  return running;
}

async function write(
  dataDir: string,
  name: string,
  expected: { size: number; sha256: string } | undefined,
): Promise<string> {
  const [group, file, ...deeper] = name.split("/");
  const digest = embedded?.digests[group ?? ""];
  if (group === undefined || file === undefined || deeper.length > 0)
    throw new Error(`cannot unpack ${name}`);
  if (digest === undefined) throw new Error(`no digest for ${group}`);
  const source = Bun.file(resource(name));
  const compressed = file.endsWith(".zst");
  const root = join(dataDir, "unpacked");
  const dir = join(root, `${group}-${digest}`);
  const target = join(dir, compressed ? file.slice(0, -4) : file);
  const size = expected?.size ?? source.size;

  if (sizeOf(target) !== size) {
    mkdirSync(dir, { recursive: true });
    // Whatever the umask made of them.
    chmodSync(root, 0o755);
    chmodSync(dir, 0o755);
    const part = join(
      dir,
      `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.part`,
    );
    const hash = createHash("sha256");
    try {
      await pipeline([
        Readable.fromWeb(source.stream() as never),
        ...(compressed ? [createZstdDecompress()] : []),
        new Transform({
          transform: (chunk: Uint8Array, _encoding, done) => {
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        createWriteStream(part),
      ]);
      const sha256 = hash.digest("hex");
      if (expected !== undefined && sha256 !== expected.sha256)
        throw new Error(
          `${name} unpacked to ${sha256}, not ${expected.sha256}`,
        );
      chmodSync(part, 0o755);
      renameSync(part, target);
    } catch (error) {
      rmSync(part, { force: true });
      throw error;
    }
  }

  for (const entry of readdirSync(root)) {
    if (entry.startsWith(`${group}-`) && join(root, entry) !== dir)
      rmSync(join(root, entry), { recursive: true, force: true });
  }
  return target;
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}
