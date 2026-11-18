/**
 * Places: the directories of a machine, as the machine itself sees them.
 *
 * Everything about a path (what `~` means, whether `C:\` is a root, what is hidden, how it is
 * shortened for display) is answered on the machine that has it, by `@eta/places`: in the host's
 * own process for the primary, in the daemon for a daemon machine. A client draws what it is
 * given and never takes a path apart itself.
 */

/** Whose rules a path follows: the machine's, not the client's. */
export type PathFlavor = "posix" | "win32";

/**
 * Why a place action failed, as `problem.code` of the wire error:
 *
 * - `offline`: the machine is not connected; `timeout`: it did not answer in time;
 * - `unsupported`: this kind of machine (SSH), or a daemon too old, cannot do it;
 * - `not_found`, `denied`, `not_directory`, `exists`: what the filesystem said;
 * - `invalid`: the path or name cannot be one on this machine (`C:\` on Linux, `a/b` as a name);
 * - `not_absolute`: a path that is relative to nothing;
 * - `auth`, `network`, `repo_not_found`: what a clone ran into; `cancelled`: it was stopped;
 * - `no_git`, `gh_signed_out`: what the machine lacks;
 * - `other`: anything else, with the machine's words in `params.detail`.
 */
export type PlaceProblem =
  | "offline"
  | "timeout"
  | "unsupported"
  | "not_found"
  | "denied"
  | "not_directory"
  | "exists"
  | "invalid"
  | "not_absolute"
  | "auth"
  | "network"
  | "repo_not_found"
  | "cancelled"
  | "no_git"
  | "gh_signed_out"
  | "other";

export const PLACE_PROBLEMS: readonly PlaceProblem[] = [
  "offline",
  "timeout",
  "unsupported",
  "not_found",
  "denied",
  "not_directory",
  "exists",
  "invalid",
  "not_absolute",
  "auth",
  "network",
  "repo_not_found",
  "cancelled",
  "no_git",
  "gh_signed_out",
  "other",
];

/** A failure as it crosses from the machine: a code and, for `other`, what was said. */
export interface PlaceFailure {
  code: PlaceProblem;
  detail?: string;
}

/** What `gh` on the machine can do: search the account's repositories, or nothing at all. */
export type GhState = "ready" | "signed_out" | "missing";

/** What a machine can do with places, so a client can grey out what it cannot. */
export interface PlaceCapabilities {
  flavor: PathFlavor;
  home: string;
  /** `git` is on the machine's PATH: cloning works. */
  git: boolean;
  gh: GhState;
  /** Making directories works (false for a daemon too old to do it). */
  mkdir: boolean;
  /** Where a clone goes when nothing else is chosen, already checked to exist. */
  cloneParent: PlaceRef;
}

/** A path, and how the machine writes it for a person (`~/Developer/eta`). */
export interface PlaceRef {
  path: string;
  display: string;
}

export interface PlaceCrumb {
  /** `~`, `/`, `C:` or a directory's name. */
  name: string;
  path: string;
}

/** A directory inside one being listed. Names only: no file is listed or read. */
export interface PlaceEntry extends PlaceRef {
  name: string;
  /** Hidden by the machine's own convention: a dot name, or a Windows system directory or link. */
  hidden: boolean;
  /** It holds a `.git`: a code repository. */
  git: boolean;
  /** The project at this path on this machine, when there is one (filled in by the host). */
  projectId: string | null;
}

/** One level of a directory, for walking to a directory by hand. */
export interface PlaceListing extends PlaceRef {
  /** Null at a root. */
  parent: PlaceRef | null;
  /** From the root (or `~`) down to the path itself, which is the last. */
  crumbs: PlaceCrumb[];
  entries: PlaceEntry[];
  /** More directories are there than were listed. */
  truncated: boolean;
  /** Every drive of a Windows machine (`C:\`, `D:\`); empty elsewhere. */
  drives: string[];
}

/** A directory found by name under the machine's home, best match first. */
export type PlaceMatch = Omit<PlaceEntry, "hidden">;

export interface PlaceSearchResult {
  query: string;
  matches: PlaceMatch[];
  /** The walk stopped at its limits before it saw the whole home. */
  truncated: boolean;
}

/** A path as typed, normalized by the machine's rules, and what is there. */
export interface PlaceResolved extends PlaceRef {
  exists: boolean;
  directory: boolean;
}

/** A repository a machine's `gh` can see. */
export interface RepoChoice {
  /** Stable for drafts: `gh:<owner/name>`, or `manual:<…>` for one that was typed. */
  id: string;
  nameWithOwner: string;
  /** A URL, or `owner/repo` when `protocol` says how to reach it. */
  cloneUrl: string;
  protocol?: "https" | "ssh";
  description: string | null;
  updatedAt: string | null;
}

export type ReposResult =
  | { available: true; repos: RepoChoice[] }
  /** Searching is not possible here; pasting a URL or `owner/repo` still is. */
  | { available: false; reason: "gh_signed_out" | "gh_missing" };

export interface CloneProgress {
  /** git's own name for it: `Receiving objects`, `Resolving deltas`, … */
  phase: string;
  /** 0–100 within the phase, when git says. */
  percent: number | null;
}

export type CloneStatus = "running" | "done" | "failed" | "cancelled";

/** A clone a machine is doing or has done, as the host keeps it for a while. */
export interface CloneView {
  id: string;
  machineId: string;
  repo: string;
  /** Where it goes (and, once done, is). */
  target: PlaceRef;
  status: CloneStatus;
  progress: CloneProgress | null;
  failure: PlaceFailure | null;
  startedAt: number;
  endedAt: number | null;
}

/** A directory used lately on a machine, or a project there. */
export interface RecentPlace extends PlaceRef {
  machineId: string;
  /** The project there, when it is one. */
  projectId: string | null;
  /** The directory it is in, as places to put something new beside it; null at a root. */
  parent: PlaceRef | null;
  /** When it was last used; projects never used here count from when they were made. */
  usedAt: number;
}

export interface PlacesSections {
  /** Every machine's, most recent first. */
  recent: RecentPlace[];
  /** Clones running and the ones that ended in the last few minutes. */
  clones: CloneView[];
}

export const PLACES_ACTIONS = [
  "capabilities",
  "resolve",
  "list",
  "search",
  "mkdir",
  "repos",
  "clone",
  "cancelClone",
  "remember",
  "importRecent",
] as const;
export type PlacesAction = (typeof PLACES_ACTIONS)[number];

/** Every action names a machine; absent means the primary. */
export interface PlacesArgs {
  capabilities: { machineId?: string };
  /** Normalize a typed path by the machine's rules: `~`, drives, backslashes. */
  resolve: { machineId?: string; path: string };
  /** One level; the machine's home when `path` is absent. */
  list: { machineId?: string; path?: string };
  search: { machineId?: string; query: string; limit?: number };
  /** A new directory `name` inside `parent`; neither may be a path the machine cannot hold. */
  mkdir: { machineId?: string; parent: string; name: string };
  /** The account's repositories (empty query) or a search, through the machine's `gh`. */
  repos: { machineId?: string; query: string };
  /**
   * Clone into `parent/<name>`, `name` being the repository's own when absent. Returns at once;
   * the clone is followed in `places.clones`.
   */
  clone: {
    machineId?: string;
    url: string;
    protocol?: "https" | "ssh";
    parent: string;
    name?: string;
  };
  cancelClone: { cloneId: string };
  /** Note that a directory was used, putting it first in `recent`. */
  remember: { machineId?: string; path: string };
  /**
   * The recent directories a client kept before they lived here, by machine, most recent first.
   * Adds what is not known yet behind what is; asking twice changes nothing.
   */
  importRecent: { recent: Record<string, string[]> };
}

export interface PlacesResults {
  capabilities: PlaceCapabilities;
  resolve: PlaceResolved;
  list: PlaceListing;
  search: PlaceSearchResult;
  mkdir: PlaceRef;
  repos: ReposResult;
  clone: { clone: CloneView };
  cancelClone: { cancelled: boolean };
  remember: Record<string, never>;
  importRecent: { added: number };
}

/**
 * What the host asks of the machine that has the places (`@eta/places`): the primary's own
 * process, or a daemon over the link (`DaemonServiceParams.places`). Projects and recent use are
 * the host's, so nothing here knows them.
 */
export type MachinePlaceOp =
  | { op: "capabilities" }
  | { op: "resolve"; path: string }
  | { op: "list"; path?: string }
  | { op: "search"; query: string; limit?: number }
  | { op: "mkdir"; parent: string; name: string }
  | { op: "repos"; query: string }
  /** Streams `CloneProgress` events; cancelling the call stops git and removes what it left. */
  | { op: "clone"; url: string; protocol?: "https" | "ssh"; target: string };

export interface MachinePlaceResults {
  capabilities: Omit<PlaceCapabilities, "cloneParent">;
  resolve: PlaceResolved;
  list: PlaceListing;
  search: PlaceSearchResult;
  mkdir: PlaceRef;
  repos: ReposResult;
  clone: PlaceRef;
}

/** A machine's answer: never a thrown error, so the code survives the link. */
export type MachinePlaceReply =
  | { ok: true; value: unknown }
  | { ok: false; failure: PlaceFailure };
