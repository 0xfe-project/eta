/** A plugin's identity and its trip to a daemon: hashing, chunks, and the copy kept there. */
import { chmodSync, realpathSync, statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginChunks, pluginHash, pluginSignature, PluginStore } from "../src";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "eta-files-")));
  dirs.push(dir);
  return dir;
}

async function tree(files: Record<string, string>): Promise<string> {
  const root = await temp();
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function send(root: string, store: PluginStore, hash: string): void {
  const batches = [...pluginChunks(root)];
  batches.forEach((files, index) =>
    store.put(hash, files, index === batches.length - 1),
  );
}

describe("a plugin's hash", () => {
  it("is the contents: the same files hash the same, wherever they are", async () => {
    const a = await tree({ "a.txt": "1", "b/c.txt": "2" });
    const b = await tree({ "b/c.txt": "2", "a.txt": "1" });
    expect(pluginHash(a)).toBe(pluginHash(b));
  });

  it("moves with a byte, a name or the executable bit, and not with .git", async () => {
    const root = await tree({ "a.txt": "1" });
    const first = pluginHash(root);
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "HEAD"), "ref");
    expect(pluginHash(root)).toBe(first);
    chmodSync(join(root, "a.txt"), 0o755);
    expect(pluginHash(root)).not.toBe(first);
    expect(pluginHash(await tree({ "a.txt": "2" }))).not.toBe(first);
    expect(pluginHash(await tree({ "b.txt": "1" }))).not.toBe(first);
  });

  it("leaves out a symlink that leaves the plugin, and follows one that stays", async () => {
    const outside = await tree({ secret: "do not send" });
    const root = await tree({ "a.txt": "1" });
    const plain = pluginHash(root);
    await symlink(join(outside, "secret"), join(root, "leak"));
    expect(pluginHash(root)).toBe(plain);
    await symlink(join(root, "a.txt"), join(root, "link.txt"));
    const files = [...pluginChunks(root)].flat();
    expect(files.map((file) => file.path)).toEqual(["a.txt", "link.txt"]);
  });

  it("survives a symlink loop", async () => {
    const root = await tree({ "a/b.txt": "1" });
    await symlink(join(root, "a"), join(root, "a", "loop"));
    expect(typeof pluginHash(root)).toBe("string");
  });
});

describe("a plugin's signature", () => {
  it("changes when a file does, without reading it", async () => {
    const root = await tree({ "a.txt": "1" });
    const before = pluginSignature(root);
    expect(pluginSignature(root)).toBe(before);
    await writeFile(join(root, "a.txt"), "22");
    expect(pluginSignature(root)).not.toBe(before);
  });
});

describe("the copies a daemon keeps", () => {
  it("rebuilds a plugin that hashes the same, executable bits included", async () => {
    const root = await tree({ "plugin.json": "{}", "bin/run": "#!/bin/sh\n" });
    chmodSync(join(root, "bin", "run"), 0o755);
    const hash = pluginHash(root);
    const store = new PluginStore(await temp());
    expect(store.has(hash)).toBe(false);
    send(root, store, hash);
    expect(store.has(hash)).toBe(true);
    expect(pluginHash(store.dir(hash))).toBe(hash);
    expect(statSync(join(store.dir(hash), "bin", "run")).mode & 0o111).toBe(
      0o111,
    );
  });

  it("moves a file larger than a frame in pieces", async () => {
    const big = "x".repeat(7 * 1024 * 1024);
    const root = await tree({ big, small: "y" });
    const hash = pluginHash(root);
    const batches = [...pluginChunks(root)];
    expect(batches.length).toBeGreaterThan(2);
    for (const batch of batches)
      expect(
        batch.reduce((sum, file) => sum + file.base64.length, 0),
      ).toBeLessThan(5 * 1024 * 1024);
    const store = new PluginStore(await temp());
    send(root, store, hash);
    expect(await readFile(join(store.dir(hash), "big"), "utf8")).toBe(big);
  });

  it("moves an empty plugin file, and an empty file among others", async () => {
    const root = await tree({ empty: "", "plugin.json": "{}" });
    const hash = pluginHash(root);
    const store = new PluginStore(await temp());
    send(root, store, hash);
    expect(pluginHash(store.dir(hash))).toBe(hash);
  });

  it("refuses a copy that does not hash to what it was told", async () => {
    const root = await tree({ "a.txt": "1" });
    const store = new PluginStore(await temp());
    const wrong = "0".repeat(64);
    expect(() => send(root, store, wrong)).toThrow(/arrived as/);
    expect(store.has(wrong)).toBe(false);
  });

  it("refuses a path out of the copy, and a name that is not a hash", async () => {
    const store = new PluginStore(await temp());
    const hash = "1".repeat(64);
    expect(() =>
      store.put(
        hash,
        [
          {
            path: "../../evil",
            executable: false,
            append: false,
            base64: "",
          },
        ],
        false,
      ),
    ).toThrow(/not a path inside/);
    expect(() => store.dir("../x")).toThrow(/not a plugin hash/);
  });
});
