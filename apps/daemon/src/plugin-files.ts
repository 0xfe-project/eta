/**
 * A plugin's files as something that can be compared and moved.
 *
 * Its identity is the hash of its contents: paths, whether each is executable, and the bytes. That
 * is what a session's stamp names, so a file that changes reopens the sessions using it, and what a
 * daemon keeps a copy under, so an unchanged plugin is not sent twice. The primary sends files in
 * pieces that fit a link frame; the daemon builds the copy beside the real one and swaps it in only
 * once it hashes to what it was told.
 */
import type { PluginFileChunk } from "@eta/client-contracts";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { isWithin, PluginError } from "./plugin-package";

/** What one plugin may hold; past this it is not read, let alone sent. */
const PLUGIN_MAX_BYTES = 128 * 1024 * 1024;
/** The bytes of file in one chunk: base64 of this fits a link frame with room for the rest. */
const CHUNK_BYTES = 3 * 1024 * 1024;

interface FileEntry {
  /** Relative to the root, with `/`. */
  path: string;
  /** Where to read it: a symlink inside the plugin is followed. */
  source: string;
  executable: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * The files of a plugin, sorted. A symlink that leaves the plugin is left out (§4.1), and so is
 * `.git`, which is how a directory came here and not part of what it is.
 */
function pluginFiles(root: string): FileEntry[] {
  const files: FileEntry[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (prefix === "" && name === ".git") continue;
      const path = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      let real = path;
      if (lstatSync(path).isSymbolicLink()) {
        try {
          real = realpathSync(path);
        } catch {
          continue;
        }
        if (!isWithin(root, real)) continue;
      }
      const stat = statSync(real);
      if (stat.isDirectory()) {
        if (seen.has(real)) continue;
        seen.add(real);
        walk(real, rel);
      } else if (stat.isFile()) {
        files.push({
          path: rel,
          source: real,
          executable: (stat.mode & 0o111) !== 0,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  walk(root, "");
  return files;
}

/** What says the files may have changed, without reading them. */
export function pluginSignature(root: string): string {
  return pluginFiles(root)
    .map((file) => `${file.path}:${file.size}:${file.mtimeMs}`)
    .join("\n");
}

/** The hash of a plugin's contents. */
export function pluginHash(root: string): string {
  const files = pluginFiles(root);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > PLUGIN_MAX_BYTES)
    throw new PluginError(
      `it holds ${Math.ceil(total / 1024 / 1024)} MiB, more than the ${PLUGIN_MAX_BYTES / 1024 / 1024} MiB a plugin may`,
    );
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\0${file.executable ? "x" : "-"}\0${file.size}\0`);
    hash.update(readFileSync(file.source));
  }
  return hash.digest("hex");
}

/** A plugin's files as chunks; the next batch starts when a frame would not take more. */
export function* pluginChunks(
  root: string,
): Generator<PluginFileChunk[], void, void> {
  let batch: PluginFileChunk[] = [];
  let bytes = 0;
  for (const file of pluginFiles(root)) {
    const content = readFileSync(file.source);
    let offset = 0;
    do {
      const part = content.subarray(offset, offset + CHUNK_BYTES);
      if (bytes + part.length > CHUNK_BYTES && batch.length > 0) {
        yield batch;
        batch = [];
        bytes = 0;
      }
      batch.push({
        path: file.path,
        executable: file.executable,
        append: offset > 0,
        base64: part.toString("base64"),
      });
      bytes += part.length;
      offset += part.length;
    } while (offset < content.length);
  }
  yield batch;
}

const HASH = /^[0-9a-f]{64}$/;

/** The copies of plugins a daemon keeps, by contents: `<root>/<hash>/`. */
export class PluginStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
    mkdirSync(root, { recursive: true });
  }

  dir(hash: string): string {
    if (!HASH.test(hash)) throw new PluginError(`not a plugin hash: ${hash}`);
    return join(this.#root, hash);
  }

  has(hash: string): boolean {
    return existsSync(this.dir(hash));
  }

  /** Take a batch; `done` means there are no more, and the copy is checked and put in place. */
  put(hash: string, files: readonly PluginFileChunk[], done: boolean): void {
    const dir = this.dir(hash);
    if (existsSync(dir)) return;
    const work = `${dir}.part`;
    for (const file of files) {
      const rel = normalize(file.path);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
        throw new PluginError(`not a path inside a plugin: ${file.path}`);
      const path = join(work, rel);
      mkdirSync(dirname(path), { recursive: true });
      const content = Buffer.from(file.base64, "base64");
      if (file.append) appendFileSync(path, content);
      else writeFileSync(path, content);
      chmodSync(path, file.executable ? 0o755 : 0o644);
    }
    if (!done) return;
    mkdirSync(work, { recursive: true });
    const got = pluginHash(work);
    if (got !== hash) {
      rmSync(work, { recursive: true, force: true });
      throw new PluginError(`plugin ${hash} arrived as ${got}`);
    }
    renameSync(work, dir);
  }
}
