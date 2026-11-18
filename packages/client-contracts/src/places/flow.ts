/**
 * Choosing a directory on a machine, as a stack of small pages: the machine, how to get there
 * (search, browse, clone from GitHub, new directory), that way's own page, and for a clone or a
 * new directory one more (where it goes, what it is called).
 *
 * A pure state machine, so the web, the phone and the terminal hold the same one and only draw
 * it. Every page is a box and a list: typing goes in the box, up and down move in the list, Enter
 * takes the row (the client does what taking it means and pushes the next page), Escape is
 * `back`. What was typed on a page is kept by the page's identity, so going back and coming in
 * again finds it as it was.
 *
 * Adapted from Paseo (`packages/app/src/add-project-flow/model.ts` and `options.ts`, commit
 * `b24eab7`, Apache License 2.0; see `./LICENSE`). Changed for eta: one draft store for every
 * page instead of two named ones, browsing is a page of its own when there is no system dialog,
 * and the reasons a way is closed are codes for each client to word.
 */
import type {
  PathFlavor,
  PlaceCapabilities,
  PlaceFailure,
  PlaceRef,
  RepoChoice,
} from "./types";

/** A machine as the flow needs it. */
export interface FlowMachine {
  id: string;
  name: string;
  kind: "primary" | "daemon" | "ssh";
  status: string;
}

export type MethodId = "search" | "browse" | "github" | "new";

interface Base {
  activeIndex: number;
  /** What the last thing tried on this page ran into. */
  error: PlaceFailure | null;
  /** Something taken on this page is under way (a check, a mkdir, a clone). */
  busy: boolean;
}

export type FlowPage =
  | ({ kind: "machine"; query: string } & Base)
  | ({ kind: "method"; machineId: string; query: string } & Base)
  | ({ kind: "search"; machineId: string; query: string } & Base)
  | ({
      kind: "browse";
      machineId: string;
      /** Null is the machine's home. */
      path: string | null;
      query: string;
      showHidden: boolean;
    } & Base)
  | ({ kind: "github"; machineId: string; query: string } & Base)
  | ({
      kind: "clone-location";
      machineId: string;
      repo: RepoChoice;
      query: string;
    } & Base)
  | ({ kind: "new-parent"; machineId: string; query: string } & Base)
  | ({
      kind: "new-name";
      machineId: string;
      parent: PlaceRef;
      query: string;
    } & Base);

export type FlowPageKind = FlowPage["kind"];

interface Draft {
  query: string;
  activeIndex: number;
}

export interface FlowState {
  machines: FlowMachine[];
  pages: FlowPage[];
  /** What was typed and where the selection was, by page identity (`pageKey`). */
  drafts: Record<string, Draft>;
}

const base: Base = { activeIndex: 0, error: null, busy: false };

/** Who a page is: the same page opened again for the same thing finds its draft. */
export function pageKey(page: FlowPage): string {
  switch (page.kind) {
    case "machine":
      return "machine";
    case "method":
      return `method\0${page.machineId}`;
    case "browse":
      return `browse\0${page.machineId}\0${page.path ?? "~"}`;
    case "clone-location":
      return `clone-location\0${page.machineId}\0${page.repo.id}`;
    case "new-name":
      return `new-name\0${page.machineId}\0${page.parent.path}`;
    default:
      return `${page.kind}\0${page.machineId}`;
  }
}

function withDraft(state: FlowState, page: FlowPage): FlowPage {
  const draft = state.drafts[pageKey(page)];
  if (draft === undefined) return page;
  return { ...page, query: draft.query, activeIndex: draft.activeIndex };
}

function push(state: FlowState, page: FlowPage): FlowState {
  return { ...state, pages: [...state.pages, withDraft(state, page)] };
}

/** A machine the flow can work on: connected, and not over SSH, which places do not reach yet. */
export function machineUsable(machine: FlowMachine): boolean {
  return machine.kind !== "ssh" && machine.status === "online";
}

/** Why a machine cannot be chosen; undefined when it can. */
export function machineClosed(
  machine: FlowMachine,
): "ssh" | "offline" | undefined {
  if (machine.kind === "ssh") return "ssh";
  return machine.status === "online" ? undefined : "offline";
}

function methodPage(machineId: string): FlowPage {
  return { kind: "method", machineId, query: "", ...base };
}

/**
 * Start the flow. The machine page is skipped when the caller names a machine, or when only one
 * can be chosen; it is then not in the stack, so Escape on the ways closes the flow.
 */
export function openFlow(input: {
  machines: FlowMachine[];
  machineId?: string | undefined;
}): FlowState {
  const state: FlowState = { machines: input.machines, pages: [], drafts: {} };
  const start = startMachine(input.machines, input.machineId);
  return {
    ...state,
    pages: [
      start === undefined
        ? { kind: "machine", query: "", ...base }
        : methodPage(start),
    ],
  };
}

function startMachine(
  machines: readonly FlowMachine[],
  preferred: string | undefined,
): string | undefined {
  if (preferred !== undefined && machines.some((m) => m.id === preferred))
    return preferred;
  // Only one machine anywhere: there is nothing to choose, even if it is away.
  if (machines.length === 1) return machines[0]!.id;
  return undefined;
}

/**
 * The machines moved (one came online, the list arrived late). A flow still on its first page,
 * the machine page, skips it once there is only one to choose.
 */
export function setMachines(
  state: FlowState,
  machines: FlowMachine[],
  preferred?: string,
): FlowState {
  const page = currentPage(state);
  if (state.pages.length !== 1 || page.kind !== "machine")
    return { ...state, machines };
  const start = startMachine(machines, preferred);
  return {
    ...state,
    machines,
    pages: start === undefined ? state.pages : [methodPage(start)],
  };
}

export function currentPage(state: FlowState): FlowPage {
  const page = state.pages.at(-1);
  if (page === undefined) throw new Error("a flow always has a page");
  return page;
}

/** One page back; null on the first page, where Escape closes the flow. */
export function back(state: FlowState): FlowState | null {
  if (state.pages.length <= 1) return null;
  return { ...state, pages: state.pages.slice(0, -1) };
}

function updateCurrent(
  state: FlowState,
  update: (page: FlowPage) => FlowPage,
): FlowState {
  const last = state.pages.length - 1;
  const pages = state.pages.map((page, index) =>
    index === last ? update(page) : page,
  );
  const page = pages[last]!;
  return {
    ...state,
    pages,
    drafts: {
      ...state.drafts,
      [pageKey(page)]: {
        query: page.query,
        activeIndex: page.activeIndex,
      },
    },
  };
}

/** What is in the box changed: the list starts over at its top, and the last error is gone. */
export function setQuery(state: FlowState, query: string): FlowState {
  return updateCurrent(state, (page) => ({
    ...page,
    query,
    activeIndex: 0,
    error: null,
  }));
}

export function setActive(state: FlowState, activeIndex: number): FlowState {
  return updateCurrent(state, (page) => ({ ...page, activeIndex }));
}

/** Up or down to the next row that can be taken, round the ends. */
export function moveActive(
  state: FlowState,
  selectable: readonly boolean[],
  direction: "next" | "previous",
): FlowState {
  return setActive(
    state,
    moveSelection(currentPage(state).activeIndex, selectable, direction),
  );
}

export function moveSelection(
  activeIndex: number,
  selectable: readonly boolean[],
  direction: "next" | "previous",
): number {
  const count = selectable.length;
  if (!selectable.some(Boolean)) return 0;
  let next = Math.min(Math.max(activeIndex, 0), count - 1);
  for (let step = 0; step < count; step += 1) {
    next = (next + (direction === "next" ? 1 : -1) + count) % count;
    if (selectable[next]) return next;
  }
  return activeIndex;
}

/** The first row that can be taken, from `activeIndex` on; for Enter on a stale index. */
export function clampActive(
  activeIndex: number,
  selectable: readonly boolean[],
): number {
  if (selectable[activeIndex] === true) return activeIndex;
  const found = selectable.findIndex(Boolean);
  return found === -1 ? 0 : found;
}

export function setBusy(state: FlowState, busy: boolean): FlowState {
  return {
    ...state,
    pages: state.pages.map((page, index) =>
      index === state.pages.length - 1
        ? { ...page, busy, ...(busy ? { error: null } : {}) }
        : page,
    ),
  };
}

export function setError(
  state: FlowState,
  error: PlaceFailure | null,
): FlowState {
  return {
    ...state,
    pages: state.pages.map((page, index) =>
      index === state.pages.length - 1 ? { ...page, error, busy: false } : page,
    ),
  };
}

export function chooseMachine(state: FlowState, machineId: string): FlowState {
  return push(state, methodPage(machineId));
}

/** Take a way on the method page. Browsing by the system's dialog is the client's; this is the page. */
export function chooseMethod(
  state: FlowState,
  machineId: string,
  method: MethodId,
): FlowState {
  switch (method) {
    case "search":
      return push(state, { kind: "search", machineId, query: "", ...base });
    case "browse":
      return openBrowse(state, machineId, null);
    case "github":
      return push(state, { kind: "github", machineId, query: "", ...base });
    case "new":
      return push(state, { kind: "new-parent", machineId, query: "", ...base });
  }
}

/**
 * Walk to `path` (null: the home). Walking replaces the browse page rather than stacking one per
 * directory: Escape leaves browsing, the crumbs go up.
 */
export function openBrowse(
  state: FlowState,
  machineId: string,
  path: string | null,
): FlowState {
  const page = currentPage(state);
  const showHidden = page.kind === "browse" ? page.showHidden : false;
  const next = withDraft(state, {
    kind: "browse",
    machineId,
    path,
    query: "",
    showHidden,
    ...base,
  });
  if (page.kind !== "browse")
    return { ...state, pages: [...state.pages, next] };
  return { ...state, pages: [...state.pages.slice(0, -1), next] };
}

export function setShowHidden(
  state: FlowState,
  showHidden: boolean,
): FlowState {
  return updateCurrent(state, (page) =>
    page.kind === "browse" ? { ...page, showHidden, activeIndex: 0 } : page,
  );
}

export function chooseRepo(state: FlowState, repo: RepoChoice): FlowState {
  const page = currentPage(state);
  if (page.kind !== "github") return state;
  return push(state, {
    kind: "clone-location",
    machineId: page.machineId,
    repo,
    query: "",
    ...base,
  });
}

export function chooseNewParent(state: FlowState, parent: PlaceRef): FlowState {
  const page = currentPage(state);
  if (page.kind !== "new-parent") return state;
  return push(state, {
    kind: "new-name",
    machineId: page.machineId,
    parent,
    query: "",
    ...base,
  });
}

/* ------------------------------------------------------------------ options */

export interface MachineOption {
  machine: FlowMachine;
  /** Why it cannot be chosen. */
  closed: "ssh" | "offline" | undefined;
}

/** The machines that match what was typed: usable ones first, the rest greyed with a reason. */
export function machineOptions(
  machines: readonly FlowMachine[],
  query: string,
): MachineOption[] {
  const needle = query.trim().toLowerCase();
  return machines
    .filter((machine) => machine.name.toLowerCase().includes(needle))
    .map((machine) => ({ machine, closed: machineClosed(machine) }))
    .sort(
      (a, b) => Number(a.closed !== undefined) - Number(b.closed !== undefined),
    );
}

/**
 * Why a way is closed, or what it is limited to:
 * - `checking`: the machine has not said what it can do yet;
 * - `no_git`: no git, so no clone;
 * - `paste_only`: `gh` is not signed in (or not there), so repositories are typed, not searched;
 * - `update`: the machine's daemon is too old for it;
 * - `native`: browsing opens the system's folder dialog.
 */
export type MethodNote =
  | "checking"
  | "no_git"
  | "paste_only"
  | "update"
  | "native";

export interface MethodOption {
  id: MethodId;
  disabled: boolean;
  note: MethodNote | undefined;
}

export function methodOptions(
  capabilities: Pick<PlaceCapabilities, "git" | "gh" | "mkdir"> | undefined,
  options: { nativeBrowse?: boolean } = {},
): MethodOption[] {
  const github: MethodOption =
    capabilities === undefined
      ? { id: "github", disabled: true, note: "checking" }
      : !capabilities.git
        ? { id: "github", disabled: true, note: "no_git" }
        : {
            id: "github",
            disabled: false,
            note: capabilities.gh === "ready" ? undefined : "paste_only",
          };
  const made: MethodOption =
    capabilities === undefined
      ? { id: "new", disabled: true, note: "checking" }
      : capabilities.mkdir
        ? { id: "new", disabled: false, note: undefined }
        : { id: "new", disabled: true, note: "update" };
  return [
    { id: "search", disabled: false, note: undefined },
    {
      id: "browse",
      disabled: false,
      note: options.nativeBrowse === true ? "native" : undefined,
    },
    github,
    made,
  ];
}

/** The repositories a GitHub page offers: what was typed as a URL or `owner/repo`, then `gh`'s. */
export function repoOptions(
  typed: readonly RepoChoice[],
  found: readonly RepoChoice[],
): RepoChoice[] {
  const seen = new Set<string>();
  const out: RepoChoice[] = [];
  for (const repo of [...typed, ...found]) {
    const key = `${repo.nameWithOwner.toLowerCase()}\0${repo.protocol ?? repo.cloneUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
  }
  return out;
}

/** Where a new directory or a clone goes, written the machine's way: `parent` + `/` or `\`. */
export function childDisplay(
  parent: PlaceRef,
  name: string,
  flavor: PathFlavor,
): string {
  const separator = flavor === "win32" ? "\\" : "/";
  const display = parent.display.replace(/[\\/]+$/, "");
  return `${display}${separator}${name}`;
}
