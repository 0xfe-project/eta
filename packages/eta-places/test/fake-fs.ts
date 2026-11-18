/**
 * A filesystem of Windows (or POSIX) paths in memory, for running places by a machine's rules on
 * any machine. A directory is a key; what it holds is the keys under it.
 */
import type { FsEntry, FSLike, PlaceFs } from "../src";
import { PlaceError } from "../src";

export function fakeFs(
  flavor: "posix" | "win32",
  paths: string[],
  options: { denied?: string[]; links?: Record<string, string> } = {},
): PlaceFs & { dirs: Set<string>; removed: string[] } {
  const sep = flavor === "win32" ? "\\" : "/";
  const norm = (path: string) =>
    flavor === "win32" ? path.toLowerCase().replace(/\//g, "\\") : path;
  const dirs = new Set<string>();
  const display = new Map<string, string>();
  const add = (path: string) => {
    let at = path;
    for (;;) {
      dirs.add(norm(at));
      display.set(norm(at), at);
      const cut = at.replace(/[\\/]+$/, "").lastIndexOf(sep);
      if (cut === 0 && flavor === "posix") {
        dirs.add("/");
        display.set("/", "/");
      }
      if (cut <= 0) break;
      const up = at.slice(0, cut);
      at = flavor === "win32" && /^[a-z]:$/i.test(up) ? `${up}\\` : up;
      if (dirs.has(norm(at))) break;
    }
  };
  for (const path of paths) add(path);
  const denied = new Set((options.denied ?? []).map(norm));
  const links = options.links ?? {};
  const removed: string[] = [];
  const childrenOf = (path: string): FsEntry[] => {
    const prefix = norm(path).replace(/[\\/]+$/, "") + sep;
    const out: FsEntry[] = [];
    for (const dir of dirs) {
      if (!dir.startsWith(prefix) || dir === prefix) continue;
      const rest = dir.slice(prefix.length);
      if (rest === "" || rest.includes(sep)) continue;
      const name = display.get(dir)!.slice(prefix.length);
      out.push({ name, kind: "directory" });
    }
    for (const [link] of Object.entries(links)) {
      const at = norm(link);
      if (at.startsWith(prefix) && !at.slice(prefix.length).includes(sep))
        out.push({ name: link.slice(prefix.length), kind: "link-directory" });
    }
    return out;
  };
  const list = async (path: string) => {
    if (denied.has(norm(path))) throw new PlaceError("denied");
    if (!dirs.has(norm(path))) throw new PlaceError("not_found");
    return childrenOf(path);
  };
  return {
    dirs,
    removed,
    list,
    walker: walkerOver(list),
    async stat(path) {
      if (
        dirs.has(norm(path)) ||
        norm(path) in
          Object.fromEntries(Object.keys(links).map((k) => [norm(k), 1]))
      )
        return { directory: true };
      return undefined;
    },
    async mkdir(path) {
      if (dirs.has(norm(path))) throw new PlaceError("exists");
      add(path);
    },
    async remove(path) {
      removed.push(path);
      for (const dir of [...dirs])
        if (dir === norm(path) || dir.startsWith(norm(path) + sep))
          dirs.delete(dir);
    },
  };
}

/**
 * An `fdir` filesystem over a `list`, for a filesystem that is not `node:fs` (a machine's paths
 * kept in memory by a test): directories as directories, links as links, which `fdir` does not
 * follow.
 */
function walkerOver(list: PlaceFs["list"]): FSLike {
  const readdir = (
    path: string,
    _options: unknown,
    done: (error: Error | null, entries?: unknown[]) => void,
  ) => {
    const at =
      path.length > 1 && /[\\/]$/.test(path) && !/^[a-z]:[\\/]$/i.test(path)
        ? path.slice(0, -1)
        : path;
    list(at).then(
      (entries) =>
        done(
          null,
          entries.map((entry) => ({
            name: entry.name,
            isDirectory: () => entry.kind === "directory",
            isFile: () => entry.kind === "file",
            isSymbolicLink: () => entry.kind.startsWith("link"),
          })),
        ),
      (error: Error) => done(error),
    );
  };
  const unsupported = () => {
    throw new Error("not walked");
  };
  return {
    readdir,
    readdirSync: unsupported,
    realpath: unsupported,
    realpathSync: unsupported,
    stat: unsupported,
    statSync: unsupported,
  } as unknown as FSLike;
}
