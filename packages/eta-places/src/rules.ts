/**
 * A machine's own rules for its paths: what `~` means, what is absolute, how a path is shortened
 * for a person and broken into crumbs.
 *
 * The rules are the machine's flavor, POSIX or Windows, and never the caller's: the host on Linux
 * answers for a daemon on Windows by Windows rules. None of it is parsed by hand: `node:path`'s
 * `posix` and `win32` say what is absolute, what a root is (`C:\`, `\\server\share\`), what is
 * inside what (case-insensitively on Windows) and how a path normalizes; `valid-filename` says
 * what a directory may be called. A path is normalized by its text and not resolved through its
 * links, so a path chosen here is the key a project is already known by.
 */
import type {
  PathFlavor,
  PlaceCrumb,
  PlaceFailure,
} from "@eta/client-contracts";
import { posix, win32 } from "node:path";
import isValidFilename from "valid-filename";

export type PathModule = typeof posix;

export function flavorOf(platform: string): PathFlavor {
  return platform === "win32" ? "win32" : "posix";
}

export function pathModule(flavor: PathFlavor): PathModule {
  return flavor === "win32" ? win32 : posix;
}

/** `~`, `~/x` and (Windows) `~\x`, as `untildify` reads them, but with the machine's home. */
const TILDE = /^~(?=$|[\\/])/;

type Resolved =
  | { ok: true; path: string }
  | { ok: false; failure: PlaceFailure };

const refused = (code: PlaceFailure["code"]): Resolved => ({
  ok: false,
  failure: { code },
});

export class PathRules {
  readonly flavor: PathFlavor;
  readonly home: string;
  readonly #p: PathModule;

  constructor(flavor: PathFlavor, home: string) {
    this.flavor = flavor;
    this.#p = pathModule(flavor);
    this.home = this.#p.normalize(home);
  }

  /**
   * A typed path as the machine means it: `~` expanded to its home, separators and dots
   * normalized. Relative paths, NUL, a Windows path on POSIX, or a path on Windows with no drive
   * or share (`\x` is on whichever drive is current) are refused, with the reason a person can
   * act on.
   */
  resolve(raw: string): Resolved {
    const typed = raw.trim();
    if (typed === "" || typed.includes("\0")) return refused("invalid");
    const expanded = TILDE.test(typed)
      ? typed.replace(TILDE, () => this.home)
      : typed;
    if (this.flavor === "posix") {
      if (posix.isAbsolute(expanded))
        return { ok: true, path: posix.resolve(expanded) };
      // `C:\x` or `\\server\share` is a path on Windows, not a name here.
      return refused(win32.isAbsolute(expanded) ? "invalid" : "not_absolute");
    }
    const { root } = win32.parse(expanded);
    if (root === "") return refused("not_absolute");
    // A bare drive (`D:`) is that drive's root; anything else relative to a drive is not one place.
    const rooted =
      win32.isAbsolute(expanded) || expanded === root
        ? win32.resolve(win32.isAbsolute(expanded) ? expanded : `${root}\\`)
        : undefined;
    if (rooted === undefined) return refused("invalid");
    // `\x` and `/x` have a root but no drive or share.
    if (win32.parse(rooted).root.length <= 1) return refused("invalid");
    const parts = rooted.slice(win32.parse(rooted).root.length).split("\\");
    if (parts.some((part) => part !== "" && !isValidFilename(part)))
      return refused("invalid");
    return { ok: true, path: rooted };
  }

  /** The path relative to the home, or undefined when it is not under it. */
  #inHome(path: string): string | undefined {
    if (this.home === this.#p.parse(this.home).root) return undefined;
    const rest = this.#p.relative(this.home, path);
    return rest.startsWith("..") || this.#p.isAbsolute(rest) ? undefined : rest;
  }

  /** `~/Developer/eta` (Windows: `~\Developer\eta`) under the home; the path itself elsewhere. */
  display(path: string): string {
    const rest = this.#inHome(path);
    if (rest === undefined) return path;
    return rest === "" ? "~" : `~${this.#p.sep}${rest}`;
  }

  /** The directory above; null at a root. */
  parent(path: string): string | null {
    const up = this.#p.dirname(path);
    return this.#p.relative(up, path) === "" ? null : up;
  }

  join(parent: string, name: string): string {
    return this.#p.join(parent, name);
  }

  /** The last part of a path: its own name, or the root itself. */
  name(path: string): string {
    return this.#p.basename(path) || path;
  }

  /**
   * From the top down to the path: under the home, from `~`; elsewhere from the root (`/`, `C:`,
   * `\\server\share`).
   */
  crumbs(path: string): PlaceCrumb[] {
    const crumbs: PlaceCrumb[] = [];
    const underHome = this.#inHome(path) !== undefined;
    for (let at = path; ; ) {
      if (underHome && this.#inHome(at) === "") {
        crumbs.push({ name: "~", path: at });
        break;
      }
      const up = this.parent(at);
      if (up === null) {
        // `C:\` reads `C:`, `\\nas\share\` reads `\\nas\share`, `/` reads `/`.
        const { root } = this.#p.parse(at);
        const name =
          root.length > 1 && root.endsWith(this.#p.sep)
            ? root.slice(0, -1)
            : root;
        crumbs.push({ name, path: at });
        break;
      }
      crumbs.push({ name: this.name(at), path: at });
      at = up;
    }
    return crumbs.reverse();
  }

  /**
   * A new directory's name: one that is a valid file name everywhere (`valid-filename`: no
   * separators or reserved characters, not `.`, `..`, `con`, `nul`, …), so a directory made on one
   * machine can be cloned or synced to another.
   */
  validName(name: string): boolean {
    return isValidFilename(name);
  }
}
