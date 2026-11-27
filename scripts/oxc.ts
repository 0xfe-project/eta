/**
 * Fetch a prebuilt oxc tool and run it.
 *
 * oxlint and oxfmt ship on npm as N-API addons, which this runtime cannot load: a .node file is a
 * shared object the engine would have to dlopen and drive through the N-API C ABI. The same tools
 * are also published as standalone binaries on GitHub releases, and a binary needs nothing from
 * the host but a file that runs.
 *
 * The version is read from devDependencies, so bumping a tool means bumping one line of
 * package.json: the npm version and the release tag are the same number (1.95.0 -> oxlint_v1.95.0).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");

/** The Rust target triple for this machine. Linux always takes musl: it is statically linked, so
 *  one download runs on every distribution. */
function target(): { triple: string; extension: string } {
  const extension = process.platform === "win32" ? "zip" : "tar.gz";
  const key = process.platform + "-" + process.arch;
  const known: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "linux-arm": "armv7-unknown-linux-musleabihf",
    "linux-riscv64": "riscv64gc-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "freebsd-x64": "x86_64-unknown-freebsd",
  };
  const triple = known[key];
  if (triple === undefined) {
    throw new Error("no oxc release for " + key + ". Known: " + Object.keys(known).join(", "));
  }
  return { triple, extension };
}

/** The version to fetch, read from the manifest so there is one place to change it. */
function version(name: string): string {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const declared = manifest.devDependencies?.[name];
  if (declared === undefined) {
    throw new Error(name + " is not listed in devDependencies of package.json");
  }
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(declared);
  if (found === null) throw new Error(name + ": no version in " + JSON.stringify(declared));
  return found[0];
}

/** Entry name -> bytes, for a tar stream that has already had its compression removed. */
function untar(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const text = (start: number, length: number): string =>
    Buffer.from(archive.subarray(start, start + length))
      .toString("utf8")
      .replace(/\0.*$/s, "");
  let at = 0;
  while (at + 512 <= archive.length) {
    const name = text(at, 100);
    // A tar archive ends with zero blocks; the first empty name is where reading stops.
    if (name === "") break;
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(archive[at + 156] ?? 0);
    const prefix = text(at + 345, 155);
    const full = prefix === "" ? name : prefix + "/" + name;
    const body = at + 512;
    // Only regular files are wanted; a link header carries no body.
    if (type === "0" || type === "\0") files.set(full, archive.subarray(body, body + size));
    at = body + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function download(url: string, to: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(url + ": " + response.status + " " + response.statusText);
  }
  writeFileSync(to, Buffer.from(await response.arrayBuffer()));
}

/** The path of the tool's binary, downloading it once per version and platform. */
async function binary(name: string): Promise<string> {
  const { triple, extension } = target();
  if (extension !== "tar.gz") {
    throw new Error("the .zip release of " + name + " needs an unzip step this script does not have");
  }
  const stamp = version(name);
  const home = join(root, "node_modules", ".cache", name, stamp, triple);
  const path = join(home, name);

  // Version and platform are both in the path, so an upgrade never reuses an old binary.
  if (existsSync(path)) return path;

  const tag = name + "_v" + stamp;
  const asset = name + "-" + triple + ".tar.gz";
  const url = "https://github.com/oxc-project/oxc/releases/download/" + tag + "/" + asset;

  mkdirSync(home, { recursive: true });
  const archive = join(home, asset);
  process.stderr.write("fetching " + name + " " + stamp + " for " + triple + "\n");
  await download(url, archive);

  const files = untar(gunzipSync(readFileSync(archive)));
  // The entry is named after the asset, not the tool (oxlint-x86_64-unknown-linux-musl inside
  // oxlint-x86_64-unknown-linux-musl.tar.gz), so match on the prefix rather than a fixed layout.
  const wanted = [...files.keys()].find((entry) => entry.startsWith(name));
  if (wanted === undefined) {
    throw new Error(asset + " contains no " + name + "; it has " + [...files.keys()].join(", "));
  }
  writeFileSync(path, files.get(wanted)!);
  chmodSync(path, 0o755);
  rmSync(archive);
  return path;
}

/** Run the tool with the output going where this process's output goes, and return its code. */
export async function run(name: string, argv: string[], cwd?: string): Promise<number> {
  const command = await binary(name);
  return new Promise((done, fail) => {
    // The working directory is the caller's, so a relative path means what it means on the command
    // line. Only the download is rooted at the repository.
    const child = spawn(command, argv, { stdio: "inherit", cwd: cwd ?? process.cwd() });
    child.on("error", fail);
    child.on("close", (code) => done(code ?? 1));
  });
}
