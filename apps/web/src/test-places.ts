import type {
  CloneView,
  PlaceCapabilities,
  PlaceListing,
  PlaceProblem,
  RecentPlace,
  RepoChoice,
} from "@eta/client-contracts";
import type { FakeHost } from "@/test-wire";

/**
 * A machine's directories behind `places.*`, for component tests: a POSIX tree kept as a list of
 * paths. It answers the way the host does, display paths and crumbs included, so a test reads what
 * a person would see. A clone runs until the test ends it.
 */
export interface FakePlaces {
  dirs: Set<string>;
  clones: CloneView[];
  /** End a clone the page started. */
  finish: (
    status: "done" | "failed",
    failure?: { code: PlaceProblem; detail?: string },
  ) => void;
  progress: (percent: number) => void;
  setRecent: (recent: RecentPlace[]) => void;
}

class Problem extends Error {
  readonly problem: { code: string };
  constructor(code: PlaceProblem) {
    super(code);
    this.problem = { code };
  }
}

export function fakePlaces(
  host: FakeHost,
  options: {
    home?: string;
    dirs?: string[];
    git?: string[];
    capabilities?: Partial<PlaceCapabilities>;
    repos?: RepoChoice[];
    recent?: RecentPlace[];
    /** Per machine, a different home; every machine shares the tree. */
    homes?: Record<string, string>;
    /** Directories that cannot be read. */
    denied?: string[];
  } = {},
): FakePlaces {
  const home = options.home ?? "/home/me";
  const dirs = new Set<string>(["/", ...(options.dirs ?? [])]);
  for (const path of [...dirs]) {
    let at = path;
    while (at.lastIndexOf("/") > 0) {
      at = at.slice(0, at.lastIndexOf("/"));
      dirs.add(at);
    }
  }
  dirs.add(home);
  const git = new Set(options.git ?? []);
  const homeOf = (machineId?: string) =>
    (machineId === undefined ? undefined : options.homes?.[machineId]) ?? home;
  const display = (path: string, machineId?: string) => {
    const h = homeOf(machineId);
    return path === h
      ? "~"
      : path.startsWith(`${h}/`)
        ? `~${path.slice(h.length)}`
        : path;
  };
  const resolve = (raw: string, machineId?: string): string => {
    const typed = raw.trim();
    const expanded =
      typed === "~" || typed.startsWith("~/")
        ? `${homeOf(machineId)}${typed.slice(1)}`
        : typed;
    if (!expanded.startsWith("/")) throw new Problem("not_absolute");
    const clean = expanded.replace(/\/+$/, "");
    return clean === "" ? "/" : clean;
  };
  const ref = (path: string, machineId?: string) => ({
    path,
    display: display(path, machineId),
  });
  const children = (path: string) =>
    [...dirs]
      .filter(
        (dir) =>
          dir !== path && dir.slice(0, dir.lastIndexOf("/") || 1) === path,
      )
      .sort();
  const clones: CloneView[] = [];
  const publish = () => host.set("places", { clones: [...clones] });
  let recent = options.recent ?? [];

  host.handle("places.capabilities", (raw) => {
    const { machineId } = raw as { machineId?: string };
    return {
      flavor: "posix",
      home: homeOf(machineId),
      git: true,
      gh: "signed_out",
      mkdir: true,
      cloneParent: ref(
        dirs.has(`${homeOf(machineId)}/Developer`)
          ? `${homeOf(machineId)}/Developer`
          : homeOf(machineId),
        machineId,
      ),
      ...options.capabilities,
    } satisfies PlaceCapabilities;
  });
  host.handle("places.resolve", (raw) => {
    const { path, machineId } = raw as { path: string; machineId?: string };
    const at = resolve(path, machineId);
    return {
      ...ref(at, machineId),
      exists: dirs.has(at),
      directory: dirs.has(at),
    };
  });
  host.handle("places.list", (raw) => {
    const { path, machineId } = raw as { path?: string; machineId?: string };
    const at = resolve(path ?? "~", machineId);
    if (!dirs.has(at)) throw new Problem("not_found");
    if (options.denied?.includes(at)) throw new Problem("denied");
    const crumbs = [];
    let walk = at;
    for (;;) {
      if (walk === homeOf(machineId)) {
        crumbs.unshift({ name: "~", path: walk });
        break;
      }
      if (walk === "/") {
        crumbs.unshift({ name: "/", path: "/" });
        break;
      }
      crumbs.unshift({
        name: walk.slice(walk.lastIndexOf("/") + 1),
        path: walk,
      });
      walk = walk.slice(0, walk.lastIndexOf("/")) || "/";
    }
    const parent =
      at === "/"
        ? null
        : ref(at.slice(0, at.lastIndexOf("/")) || "/", machineId);
    return {
      ...ref(at, machineId),
      parent,
      crumbs,
      entries: children(at).map((child) => {
        const name = child.slice(child.lastIndexOf("/") + 1);
        return {
          ...ref(child, machineId),
          name,
          hidden: name.startsWith("."),
          git: git.has(child),
          projectId: null,
        };
      }),
      truncated: false,
      drives: [],
    } satisfies PlaceListing;
  });
  host.handle("places.search", (raw) => {
    const { query, machineId } = raw as { query: string; machineId?: string };
    const q = query.trim().toLowerCase();
    const typed = q.startsWith("~") || q.startsWith("/");
    const at = typed ? resolve(query, machineId) : "";
    const parent = at.slice(0, at.lastIndexOf("/")) || "/";
    const term = at.slice(at.lastIndexOf("/") + 1).toLowerCase();
    if (typed) {
      const matches = children(parent)
        .filter((dir) =>
          dir
            .slice(dir.lastIndexOf("/") + 1)
            .toLowerCase()
            .startsWith(term),
        )
        .map((dir) => ({
          ...ref(dir, machineId),
          name: dir.slice(dir.lastIndexOf("/") + 1),
          git: git.has(dir),
          projectId: null,
        }));
      return { query, matches, truncated: false };
    }
    const matches = [...dirs]
      .filter((dir) => dir.startsWith(`${homeOf(machineId)}/`))
      .filter((dir) => {
        const name = dir.slice(dir.lastIndexOf("/") + 1);
        return !name.startsWith(".") && name.toLowerCase().includes(q);
      })
      .sort()
      .map((dir) => ({
        ...ref(dir, machineId),
        name: dir.slice(dir.lastIndexOf("/") + 1),
        git: git.has(dir),
        projectId: null,
      }));
    return { query, matches, truncated: false };
  });
  host.handle("places.mkdir", (raw) => {
    const { parent, name, machineId } = raw as {
      parent: string;
      name: string;
      machineId?: string;
    };
    if (name.includes("/") || name === "") throw new Problem("invalid");
    const at = `${resolve(parent, machineId)}/${name}`;
    if (dirs.has(at)) throw new Problem("exists");
    dirs.add(at);
    return ref(at, machineId);
  });
  host.handle("places.repos", () =>
    options.capabilities?.gh === "ready"
      ? { available: true, repos: options.repos ?? [] }
      : { available: false, reason: "gh_signed_out" },
  );
  host.handle("places.clone", (raw) => {
    const { url, parent, machineId } = raw as {
      url: string;
      parent: string;
      machineId?: string;
    };
    const name = url
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .at(-1)!;
    const target = `${resolve(parent, machineId)}/${name}`;
    const clone: CloneView = {
      id: `clone-${clones.length + 1}`,
      machineId: machineId ?? "m1",
      repo: url,
      target: ref(target, machineId),
      status: "running",
      progress: null,
      failure: null,
      startedAt: 1,
      endedAt: null,
    };
    clones.push(clone);
    publish();
    return { clone };
  });
  host.handle("places.cancelClone", (raw) => {
    const { cloneId } = raw as { cloneId: string };
    const at = clones.findIndex((clone) => clone.id === cloneId);
    if (at === -1 || clones[at]!.status !== "running")
      return { cancelled: false };
    clones[at] = {
      ...clones[at]!,
      status: "cancelled",
      failure: { code: "cancelled" },
      endedAt: 2,
    };
    publish();
    return { cancelled: true };
  });
  host.handle("places.remember", () => ({}));
  host.handle("places.importRecent", () => ({ added: 0 }));

  return {
    dirs,
    clones,
    finish(status, failure) {
      const at = clones.length - 1;
      const clone = clones[at]!;
      if (status === "done") dirs.add(clone.target.path);
      clones[at] = { ...clone, status, failure: failure ?? null, endedAt: 2 };
      publish();
    },
    progress(percent) {
      const at = clones.length - 1;
      clones[at] = {
        ...clones[at]!,
        progress: { phase: "Receiving objects", percent },
      };
      publish();
    },
    setRecent(next) {
      recent = next;
      host.set("places", { recent });
    },
  };
}
