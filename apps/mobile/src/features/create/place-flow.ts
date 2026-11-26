// Choosing a directory on a machine, as the shared flow (`@eta/client-contracts` places/flow)
// says, with the host's `places.*` behind it. The page (PlacePicker.tsx) only draws what this
// gives it: the machine's own answers (display paths, crumbs, git and project marks) as they come.

import type {
  CloneView,
  FlowMachine,
  FlowState,
  MethodNote,
  PlaceCapabilities,
  PlaceFailure,
  PlaceListing,
  PlaceRef,
  PlaceResolved,
  PlaceSearchResult,
  RecentPlace,
  RepoChoice,
  ReposResult,
} from "@eta/client-contracts";
import {
  back,
  buildSuggestions,
  childDisplay,
  chooseMachine,
  chooseMethod,
  chooseNewParent,
  chooseRepo,
  currentPage,
  machineOptions,
  manualRepoChoices,
  methodOptions,
  openBrowse,
  openFlow,
  parentsOf,
  PLACE_PROBLEMS,
  repoName,
  repoOptions,
  setBusy,
  setError,
  setMachines,
  setQuery,
  setShowHidden,
} from "@eta/client-contracts";
import { computed, effect, signal, untracked } from "nsh";
import { machines } from "../../app/lists";
import { t } from "../../i18n";
import { call } from "../../wire/target";

/** Where the flow ends: a directory on a machine, as that machine writes it. */
export interface PlaceChoice {
  machineId: string;
  path: string;
  display: string;
}

export interface FlowRow {
  key: string;
  section?: string;
  label: string;
  detail?: string;
  tags: string[];
  disabled: boolean;
  /** It goes deeper rather than ending the flow. */
  goes: boolean;
  take: () => void;
}

const NOTE_KEYS = {
  checking: "create.places.note.checking",
  no_git: "create.places.note.noGit",
  paste_only: "create.places.note.pasteOnly",
  update: "create.places.note.update",
  native: "create.places.note.native",
} as const satisfies Record<MethodNote, string>;

const PROBLEM_KEYS = {
  offline: "create.places.problem.offline",
  timeout: "create.places.problem.timeout",
  unsupported: "create.places.problem.unsupported",
  not_found: "create.places.problem.notFound",
  denied: "create.places.problem.denied",
  not_directory: "create.places.problem.notDirectory",
  exists: "create.places.problem.exists",
  invalid: "create.places.problem.invalid",
  not_absolute: "create.places.problem.notAbsolute",
  auth: "create.places.problem.auth",
  network: "create.places.problem.network",
  repo_not_found: "create.places.problem.repoNotFound",
  cancelled: "create.places.problem.cancelled",
  no_git: "create.places.problem.noGit",
  gh_signed_out: "create.places.problem.ghSignedOut",
  other: "create.places.problem.other",
} as const satisfies Record<PlaceFailure["code"], string>;

/** The words for a page's box, by the page. */
export const PLACEHOLDER_KEYS = {
  machine: "create.places.placeholder.machine",
  method: "create.places.placeholder.method",
  search: "create.places.placeholder.search",
  browse: "create.places.placeholder.browse",
  github: "create.places.placeholder.github",
  "clone-location": "create.places.placeholder.cloneLocation",
  "new-parent": "create.places.placeholder.newParent",
  "new-name": "create.places.placeholder.newName",
} as const;

/** `not_found` is `create.places.problem.notFound`. */
export const problemKey = (code: PlaceFailure["code"]) => PROBLEM_KEYS[code];

/** A failure as the host said it: its `problem.code`, or what went wrong on the way. */
function failureOf(error: unknown): PlaceFailure {
  const problem = (
    error as {
      problem?: { code?: unknown; params?: { detail?: unknown } };
    } | null
  )?.problem;
  const code = PLACE_PROBLEMS.find((known) => known === problem?.code);
  if (code !== undefined) {
    const detail = problem?.params?.detail;
    return typeof detail === "string" ? { code, detail } : { code };
  }
  return {
    code: "other",
    detail: error instanceof Error ? error.message : String(error),
  };
}

class Problem extends Error {
  readonly problem: { code: string };
  constructor(code: PlaceFailure["code"]) {
    super(code);
    this.problem = { code };
  }
}

const flowMachines = (): FlowMachine[] =>
  machines()
    .filter((m) => m.status !== "pending")
    .map(({ id, name, kind, status }) => ({ id, name, kind, status }));

export function createPlaceFlow(options: {
  machineId?: string | undefined;
  recent: () => readonly RecentPlace[];
  clones: () => readonly CloneView[];
  onChoose: (choice: PlaceChoice) => void;
}) {
  const state = signal<FlowState>(
    openFlow({ machines: flowMachines(), machineId: options.machineId }),
  );
  const update = (next: (now: FlowState) => FlowState) =>
    state.set(next(untracked(() => state())));
  effect(() => {
    const listed = flowMachines();
    update((now) => setMachines(now, listed, options.machineId));
  });

  const page = computed(() => currentPage(state()));
  const machineId = computed(() => {
    const at = page();
    return at.kind === "machine" ? undefined : at.machineId;
  });

  // The answers, by what was asked; a late answer to an old question is kept but not shown.
  const caps = signal<Record<string, PlaceCapabilities | PlaceFailure>>({});
  const searches = signal<Record<string, PlaceSearchResult>>({});
  const listings = signal<Record<string, PlaceListing | PlaceFailure>>({});
  const repos = signal<Record<string, ReposResult>>({});
  const put = <T>(
    store: { (): Record<string, T>; set: (value: Record<string, T>) => void },
    key: string,
    value: T,
  ) => store.set({ ...untracked(() => store()), [key]: value });

  effect(() => {
    const id = machineId();
    if (id === undefined || untracked(() => caps())[id] !== undefined) return;
    call<PlaceCapabilities>("places", "capabilities", { machineId: id }).then(
      (value) => put(caps, id, value),
      (error: unknown) => put(caps, id, failureOf(error)),
    );
  });
  const capabilities = (): PlaceCapabilities | undefined => {
    const id = machineId();
    const found = id === undefined ? undefined : caps()[id];
    return found !== undefined && "home" in found ? found : undefined;
  };
  const flavor = () => {
    const found = capabilities()?.flavor;
    if (found !== undefined) return found;
    return machines().find((m) => m.id === machineId())?.os === "win32"
      ? "win32"
      : "posix";
  };

  // What was typed, a moment after the typing stopped.
  const settled = signal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const typed = page().query.trim();
    clearTimeout(timer);
    timer = setTimeout(() => settled.set(typed), 200);
  });

  const searchKey = computed(() => {
    const at = page();
    const typed = settled();
    if (
      typed === "" ||
      typed !== at.query.trim() ||
      at.kind === "machine" ||
      !(
        at.kind === "search" ||
        at.kind === "new-parent" ||
        at.kind === "clone-location"
      )
    )
      return undefined;
    return `${at.machineId}\0${typed}`;
  });
  effect(() => {
    const key = searchKey();
    const id = machineId();
    if (key === undefined || id === undefined) return;
    if (untracked(() => searches())[key] !== undefined) return;
    const query = untracked(() => settled());
    call<PlaceSearchResult>("places", "search", { machineId: id, query }).then(
      (value) => put(searches, key, value),
      () => put(searches, key, { query, matches: [], truncated: false }),
    );
  });

  const listingKey = computed(() => {
    const at = page();
    return at.kind === "browse"
      ? `${at.machineId}\0${at.path ?? "~"}`
      : undefined;
  });
  const askListing = (force = false) => {
    const key = untracked(() => listingKey());
    const at = untracked(() => page());
    if (key === undefined || at.kind !== "browse") return;
    if (!force && untracked(() => listings())[key] !== undefined) return;
    call<PlaceListing>("places", "list", {
      machineId: at.machineId,
      ...(at.path === null ? {} : { path: at.path }),
    }).then(
      (value) => put(listings, key, value),
      (error: unknown) => put(listings, key, failureOf(error)),
    );
  };
  effect(() => {
    if (listingKey() !== undefined) askListing();
  });
  const listing = (): PlaceListing | undefined => {
    const key = listingKey();
    const found = key === undefined ? undefined : listings()[key];
    return found !== undefined && "crumbs" in found ? found : undefined;
  };
  // The last directory that could be listed: its crumbs stay up while one that cannot be is
  // shown, so there is a way back from it.
  const lastListed = signal<PlaceListing | undefined>(undefined);
  effect(() => {
    const listed = listing();
    if (listed !== undefined) lastListed.set(listed);
  });
  const crumbs = () =>
    page().kind === "browse" ? (listing() ?? lastListed())?.crumbs : undefined;

  const reposKey = computed(() => {
    const at = page();
    if (at.kind !== "github" || capabilities()?.gh !== "ready")
      return undefined;
    return `${at.machineId}\0${settled()}`;
  });
  effect(() => {
    const key = reposKey();
    const id = machineId();
    if (key === undefined || id === undefined) return;
    if (untracked(() => repos())[key] !== undefined) return;
    call<ReposResult>("places", "repos", {
      machineId: id,
      query: untracked(() => settled()),
    }).then(
      (value) => put(repos, key, value),
      () => put(repos, key, { available: false, reason: "gh_signed_out" }),
    );
  });

  const fail = (error: unknown) =>
    update((now) => setError(now, failureOf(error)));

  // The clone this flow started, as the host follows it.
  const cloneId = signal<string | undefined>(undefined);
  const clone = computed(() =>
    options.clones().find((each) => each.id === cloneId()),
  );
  effect(() => {
    const running = clone();
    if (running === undefined || running.status === "running") return;
    cloneId.set(undefined);
    if (running.status === "done")
      options.onChoose({ machineId: running.machineId, ...running.target });
    else update((now) => setError(now, running.failure ?? { code: "other" }));
  });

  const open = (target: string, then?: (place: PlaceRef) => void) => {
    const id = machineId();
    if (id === undefined) return;
    update((now) => setBusy(now, true));
    call<PlaceResolved>("places", "resolve", {
      machineId: id,
      path: target,
    }).then((found) => {
      if (!found.exists) return fail(new Problem("not_found"));
      if (!found.directory) return fail(new Problem("not_directory"));
      update((now) => setBusy(now, false));
      const place = { path: found.path, display: found.display };
      if (then !== undefined) then(place);
      else options.onChoose({ machineId: id, ...place });
    }, fail);
  };

  const startClone = (repo: RepoChoice, parent: PlaceRef) => {
    const id = machineId();
    if (id === undefined) return;
    update((now) => setBusy(now, true));
    call<{ clone: CloneView }>("places", "clone", {
      machineId: id,
      url: repo.cloneUrl,
      ...(repo.protocol === undefined ? {} : { protocol: repo.protocol }),
      parent: parent.path,
    }).then((started) => cloneId.set(started.clone.id), fail);
  };

  const takeLocation = (place: PlaceRef) => {
    const at = page();
    const id = machineId();
    if (id === undefined) return;
    if (at.kind === "new-parent") update((now) => chooseNewParent(now, place));
    else if (at.kind === "clone-location") startClone(at.repo, place);
    else options.onChoose({ machineId: id, ...place });
  };

  const rows = computed((): FlowRow[] => {
    const at = page();
    const recent = options
      .recent()
      .filter((place) => place.machineId === machineId());
    switch (at.kind) {
      case "machine":
        return machineOptions(state().machines, at.query).map(
          ({ machine, closed }) => ({
            key: machine.id,
            label: machine.name,
            detail: t(`create.places.kind.${machine.kind}`),
            tags:
              closed === undefined ? [] : [t(`create.places.closed.${closed}`)],
            disabled: closed !== undefined,
            goes: true,
            take: () => update((now) => chooseMachine(now, machine.id)),
          }),
        );
      case "method":
        return methodOptions(capabilities()).map((option) => ({
          key: option.id,
          label: t(`create.places.way.${option.id}`),
          ...(option.note === undefined
            ? {}
            : { detail: t(NOTE_KEYS[option.note]) }),
          tags: [],
          disabled: option.disabled,
          goes: true,
          take: () =>
            update((now) => chooseMethod(now, at.machineId, option.id)),
        }));
      case "search":
      case "new-parent":
      case "clone-location": {
        const caps = capabilities();
        const parents: PlaceRef[] =
          caps === undefined
            ? []
            : at.kind === "clone-location"
              ? [caps.cloneParent]
              : at.kind === "new-parent"
                ? [{ path: caps.home, display: "~" }]
                : [];
        const key = searchKey();
        const found = key === undefined ? [] : (searches()[key]?.matches ?? []);
        const name =
          at.kind === "clone-location"
            ? repoName(at.repo.nameWithOwner)
            : undefined;
        return buildSuggestions({
          query: at.query,
          flavor: flavor(),
          os: machines().find((m) => m.id === machineId())?.os,
          recent:
            at.kind === "search" ? recent : [...parents, ...parentsOf(recent)],
          found,
        }).map((suggestion): FlowRow => {
          if (suggestion.kind === "typed")
            return {
              key: `typed:${suggestion.path}`,
              section: t("create.places.section.typed"),
              label: t("create.places.open", { path: suggestion.path }),
              tags: [],
              disabled: false,
              goes: at.kind !== "search",
              take: () =>
                open(
                  suggestion.path,
                  at.kind === "search" ? undefined : takeLocation,
                ),
            };
          const place = suggestion.place;
          return {
            key: `${suggestion.kind}:${place.path}`,
            section: t(
              suggestion.kind === "found"
                ? "create.places.section.found"
                : at.kind === "search"
                  ? "create.picker.recent"
                  : "create.places.section.suggested",
            ),
            label:
              name === undefined
                ? place.display
                : childDisplay(place, name, flavor()),
            tags: [
              ...("git" in place && place.git === true ? ["git"] : []),
              ...("projectId" in place && place.projectId !== null
                ? [t("create.picker.added")]
                : []),
            ],
            disabled: false,
            goes: at.kind !== "search",
            take: () =>
              takeLocation({ path: place.path, display: place.display }),
          };
        });
      }
      case "browse": {
        const listed = listing();
        if (listed === undefined) return [];
        const needle = at.query.trim().toLowerCase();
        return listed.entries
          .filter(
            (entry) =>
              (at.showHidden || !entry.hidden) &&
              entry.name.toLowerCase().includes(needle),
          )
          .map((entry) => ({
            key: entry.path,
            label: entry.name,
            tags: [
              ...(entry.git ? ["git"] : []),
              ...(entry.projectId === null ? [] : [t("create.picker.added")]),
            ],
            disabled: false,
            goes: true,
            take: () =>
              update((now) => openBrowse(now, at.machineId, entry.path)),
          }));
      }
      case "github": {
        const key = reposKey();
        const answer = key === undefined ? undefined : repos()[key];
        const found = answer?.available === true ? answer.repos : [];
        return repoOptions(manualRepoChoices(at.query), found).map((repo) => ({
          key: repo.id,
          section: t(
            repo.id.startsWith("manual:")
              ? "create.places.section.typedRepo"
              : "create.places.section.repos",
          ),
          label: repo.nameWithOwner,
          ...(repo.protocol === undefined
            ? repo.description === null
              ? {}
              : { detail: repo.description }
            : {
                detail: t("create.places.via", {
                  protocol: repo.protocol.toUpperCase(),
                }),
              }),
          tags: [],
          disabled: false,
          goes: true,
          take: () => update((now) => chooseRepo(now, repo)),
        }));
      }
      case "new-name": {
        const name = at.query.trim();
        if (name === "") return [];
        return [
          {
            key: `new:${name}`,
            label: t("create.places.create", {
              path: childDisplay(at.parent, name, flavor()),
            }),
            tags: [],
            disabled: false,
            goes: false,
            take: () => {
              update((now) => setBusy(now, true));
              call<PlaceRef>("places", "mkdir", {
                machineId: at.machineId,
                parent: at.parent.path,
                name,
              }).then((made) => {
                update((now) => setBusy(now, false));
                options.onChoose({ machineId: at.machineId, ...made });
              }, fail);
            },
          },
        ];
      }
    }
  });

  const problem = computed((): PlaceFailure | null => {
    const at = page();
    if (at.error !== null) return at.error;
    if (at.kind === "browse") {
      const key = listingKey();
      const found = key === undefined ? undefined : listings()[key];
      if (found !== undefined && "code" in found) return found;
    }
    if (at.kind === "method") {
      const id = machineId();
      const found = id === undefined ? undefined : caps()[id];
      if (found !== undefined && "code" in found) return found;
    }
    return null;
  });

  return {
    state,
    page,
    machineId,
    capabilities,
    flavor,
    rows,
    listing,
    crumbs,
    problem,
    clone,
    type: (value: string) => update((now) => setQuery(now, value)),
    walk: (path: string | null) => {
      const id = machineId();
      if (id !== undefined) update((now) => openBrowse(now, id, path));
    },
    useHere: () => {
      const listed = listing();
      const id = machineId();
      if (listed !== undefined && id !== undefined)
        options.onChoose({
          machineId: id,
          path: listed.path,
          display: listed.display,
        });
    },
    showHidden: (show: boolean) => update((now) => setShowHidden(now, show)),
    retry: () => {
      update((now) => setError(now, null));
      const id = machineId();
      if (id !== undefined) {
        const next = { ...untracked(() => caps()) };
        delete next[id];
        caps.set(next);
      }
      askListing(true);
    },
    /** One page back; false on the first page, where the back arrow leaves the picker. */
    back: (): boolean => {
      const running = cloneId();
      if (running !== undefined) {
        void call("places", "cancelClone", { cloneId: running });
        return true;
      }
      const previous = back(untracked(() => state()));
      if (previous === null) return false;
      state.set(previous);
      return true;
    },
  };
}
