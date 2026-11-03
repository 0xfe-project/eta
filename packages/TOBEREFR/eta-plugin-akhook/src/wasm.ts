/**
 * The two wasm files the shell splitter needs: tree-sitter's runtime and the bash grammar.
 *
 * In a checkout they are files in `node_modules`. The daemon is a `bun build --compile` single
 * file, which has no `node_modules`: there they are embedded in the executable (the literal
 * `with { type: "file" }` imports are what tell the bundler to), and `Bun.file` reads them.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export interface ShellWasm {
  runtime: Uint8Array;
  bash: Uint8Array;
}

async function fromModules(): Promise<ShellWasm> {
  const require = createRequire(import.meta.url);
  const [runtime, bash] = await Promise.all([
    readFile(require.resolve("web-tree-sitter/web-tree-sitter.wasm")),
    readFile(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")),
  ]);
  return { runtime: new Uint8Array(runtime), bash: new Uint8Array(bash) };
}

async function fromExecutable(): Promise<ShellWasm> {
  const [runtime, bash] = await Promise.all([
    // @ts-expect-error -- a Bun file import, resolved by the bundler; not a module to TypeScript
    import("web-tree-sitter/web-tree-sitter.wasm", { with: { type: "file" } }),
    // @ts-expect-error -- same
    import("tree-sitter-bash/tree-sitter-bash.wasm", {
      with: { type: "file" },
    }),
  ]);
  const read = async (path: string): Promise<Uint8Array> =>
    await Bun.file(path).bytes();
  return {
    runtime: await read((runtime as { default: string }).default),
    bash: await read((bash as { default: string }).default),
  };
}

let loaded: Promise<ShellWasm> | undefined;

export function shellWasm(): Promise<ShellWasm> {
  loaded ??= fromModules()
    .catch(fromExecutable)
    .catch((error: unknown) => {
      loaded = undefined;
      throw error;
    });
  return loaded;
}
