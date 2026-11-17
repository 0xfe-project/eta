import type { MachineView, ProjectView } from "@eta/client-contracts";

const WINDOWS_PATH = /^[a-z]:[\\/]/i;

export interface PathCrumb {
  name: string;
  path: string;
}

/** The last segment of a path, for showing a folder by its name. */
export function folderName(path: string): string {
  const windows = WINDOWS_PATH.test(path);
  const trimmed = windows
    ? path.replaceAll("/", "\\").replace(/\\+$/, "")
    : path.replace(/\/+$/, "");
  if (trimmed.length === 0) return path;
  const name = trimmed.slice(trimmed.lastIndexOf(windows ? "\\" : "/") + 1);
  return name.length === 0 ? trimmed : name;
}

/** The directory above `path`; undefined at a root. */
export function parentPath(path: string): string | undefined {
  if (!WINDOWS_PATH.test(path)) {
    if (path === "/") return undefined;
    return path.slice(0, path.lastIndexOf("/")) || "/";
  }
  const normalized = path.replaceAll("/", "\\").replace(/\\+$/, "");
  if (/^[a-z]:$/i.test(normalized)) return undefined;
  const parent = normalized.slice(0, normalized.lastIndexOf("\\"));
  return /^[a-z]:$/i.test(parent) ? `${parent}\\` : parent;
}

/** A child of a directory, with that directory's own separator style. */
export function joinPath(base: string, name: string): string {
  if (!WINDOWS_PATH.test(base)) {
    return `${base === "/" ? "" : base}/${name}`;
  }
  return `${base.replaceAll("/", "\\").replace(/\\+$/, "")}\\${name}`;
}

/**
 * A path as crumbs to walk. POSIX keeps the current `~` convention; Windows adds the drive above
 * the home, so `C:` remains reachable from `C:\Users\…`.
 */
export function pathCrumbs(
  path: string,
  home: string | null | undefined,
): PathCrumb[] {
  if (!WINDOWS_PATH.test(path)) {
    const inside =
      home !== null &&
      home !== undefined &&
      home !== "/" &&
      (path === home || path.startsWith(`${home}/`));
    const root = inside ? home : "/";
    const crumbs = inside
      ? [
          { name: "/", path: "/" },
          { name: "~", path: root },
        ]
      : [{ name: "/", path: root }];
    let at = inside ? home : "";
    for (const name of path.slice(root.length).split("/")) {
      if (name === "") continue;
      at = `${at}/${name}`;
      crumbs.push({ name, path: at });
    }
    return crumbs;
  }

  const drive = path.slice(0, 2);
  const root = `${drive}\\`;
  const crumbs = [{ name: drive, path: root }];
  const segments = path
    .slice(2)
    .split(/[\\/]+/)
    .filter(Boolean);
  const normalizedHome = home?.replaceAll("/", "\\").replace(/\\+$/, "");
  const insideHome =
    normalizedHome !== undefined &&
    normalizedHome.toLowerCase().startsWith(`${drive.toLowerCase()}\\`) &&
    (path.toLowerCase() === normalizedHome.toLowerCase() ||
      path.toLowerCase().startsWith(`${normalizedHome.toLowerCase()}\\`));

  if (insideHome) {
    crumbs.push({ name: "~", path: normalizedHome });
    const homeSegments = normalizedHome
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean);
    let at = normalizedHome;
    for (const name of segments.slice(homeSegments.length)) {
      at = joinPath(at, name);
      crumbs.push({ name, path: at });
    }
    return crumbs;
  }

  let at = root;
  for (const name of segments) {
    at = joinPath(at, name);
    crumbs.push({ name, path: at });
  }
  return crumbs;
}

/**
 * Where a project is, as one line: its path, with the machine's name in front when that machine is
 * not the primary (`gpu-box:/home/eric/training`).
 *
 * A path is unique only per machine, so `eta` on the primary and `eta` on a daemon at the same path
 * would otherwise read the same. Someone with one machine never sees a prefix. `short` writes the
 * machine's own home as `~` — that machine's, because a daemon's paths live under its home, not
 * the primary's. The machine list can arrive after the projects: until the project's machine is
 * in it, the line is the bare path rather than a guess.
 */
export function projectPlace(
  project: Pick<ProjectView, "machineId" | "path">,
  machines: readonly MachineView[],
  { short = false }: { short?: boolean } = {},
): string {
  const machine = machines.find(
    (candidate) => candidate.id === project.machineId,
  );
  if (machine === undefined) return project.path;
  const path = short ? shortenPath(project.path, machine.home) : project.path;
  return machine.kind === "primary" ? path : `${machine.name}:${path}`;
}

/** `~/Desktop/eta`, not `/Users/lemonhx/Desktop/eta`. */
export function shortenPath(path: string, home: string | null): string {
  if (home === null) return path;
  if (WINDOWS_PATH.test(path)) {
    const normalizedHome = home.replaceAll("/", "\\").replace(/\\+$/, "");
    const normalizedPath = path.replaceAll("/", "\\");
    if (normalizedPath.toLowerCase() === normalizedHome.toLowerCase())
      return "~";
    if (
      normalizedPath
        .toLowerCase()
        .startsWith(`${normalizedHome.toLowerCase()}\\`)
    ) {
      const relative = normalizedPath
        .slice(normalizedHome.length + 1)
        .replaceAll("\\", "/");
      return `~/${relative}`;
    }
    return path;
  }
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  if (path === home) return "~";
  return path;
}
