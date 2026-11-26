/**
 * The first step of `/new`: choosing a directory on a machine, as the shared flow
 * (`@eta/client-contracts` `places/flow`) says, asked of the host's `places.*`. The layer only
 * draws what this gives it; up, down, Enter and Esc go through `key`.
 */
import type {
  CloneView,
  FlowMachine,
  FlowState,
  MachineView,
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
import type { WireClient } from "../../../connection/types";
import type { Translate as TranslateOf } from "../../../i18n/messages";
import type { manageMessages } from "../messages";
import {
  back,
  buildSuggestions,
  childDisplay,
  chooseMachine,
  chooseMethod,
  chooseNewParent,
  chooseRepo,
  clampActive,
  currentPage,
  machineOptions,
  manualRepoChoices,
  methodOptions,
  moveActive,
  openBrowse,
  openFlow,
  parentsOf,
  PLACE_PROBLEMS,
  repoName,
  repoOptions,
  setActive,
  setBusy,
  setError,
  setMachines,
  setQuery,
  setShowHidden,
} from "@eta/client-contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { machinesOf } from "../../../extensions/eager-lists";

type Translate = TranslateOf<keyof (typeof manageMessages)["en"]>;

/** Where the flow ends: a directory on a machine, as that machine writes it. */
export interface PlaceChoice {
  machineId: string;
  path: string;
  display: string;
}

export interface FlowRow {
  key: string;
  label: string;
  note?: string;
  disabled: boolean;
  take: () => void;
}

const NONE: readonly never[] = [];

const NOTE_KEYS = {
  checking: "noteChecking",
  no_git: "noteNoGit",
  paste_only: "notePasteOnly",
  update: "noteUpdate",
  native: "noteNative",
} as const satisfies Record<MethodNote, string>;

const WAY_KEYS = {
  search: "waySearch",
  browse: "wayBrowse",
  github: "wayGithub",
  new: "wayNew",
} as const;

/** The words for a failure: `not_found` is `problemNotFound`. */
export const PROBLEM_KEYS = {
  offline: "problemOffline",
  timeout: "problemTimeout",
  unsupported: "problemUnsupported",
  not_found: "problemNotFound",
  denied: "problemDenied",
  not_directory: "problemNotDirectory",
  exists: "problemExists",
  invalid: "problemInvalid",
  not_absolute: "problemNotAbsolute",
  auth: "problemAuth",
  network: "problemNetwork",
  repo_not_found: "problemRepoNotFound",
  cancelled: "problemCancelled",
  no_git: "problemNoGit",
  gh_signed_out: "problemGhSignedOut",
  other: "problemOther",
} as const satisfies Record<PlaceFailure["code"], string>;

const flowMachines = (machines: readonly MachineView[]): FlowMachine[] =>
  machines
    .filter((m) => m.status !== "pending")
    .map(({ id, name, kind, status }) => ({ id, name, kind, status }));

/** A failure as the host said it: its `problem.code`, or what went wrong on the way. */
export function failureOf(error: unknown): PlaceFailure {
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

/** A failure found before the host was asked. */
class Problem extends Error {
  readonly problem: { code: string };
  constructor(code: PlaceFailure["code"]) {
    super(code);
    this.problem = { code };
  }
}

/** The answer to the newest question of a kind; one left behind is dropped. */
function useAnswer<T>(
  ask: (() => Promise<T>) | undefined,
  key: string,
): { value: T | undefined; error: unknown; pending: boolean } {
  const [answer, setAnswer] = useState<{
    key: string;
    value?: T;
    error?: unknown;
  }>({ key: "" });
  const askRef = useRef(ask);
  askRef.current = ask;
  // Asked again when the question changes, and when it becomes one that can be asked (the
  // machine said what it can do).
  const askable = ask !== undefined;
  useEffect(() => {
    const asking = askRef.current;
    if (asking === undefined) return;
    let current = true;
    asking().then(
      (value) => {
        if (current) setAnswer({ key, value });
      },
      (error: unknown) => {
        if (current) setAnswer({ key, error: error ?? new Error("failed") });
      },
    );
    return () => {
      current = false;
    };
  }, [key, askable]);
  const fresh = answer.key === key;
  return {
    value: fresh ? answer.value : undefined,
    error: fresh ? answer.error : undefined,
    pending: ask !== undefined && !fresh,
  };
}

/** What was typed, a moment after the typing stopped. */
function useSettled(value: string, ms = 150): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(setSettled, ms, value);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function usePlaceFlow(options: {
  wire: WireClient;
  t: Translate;
  onChoose: (choice: PlaceChoice) => void;
}) {
  const { wire, t } = options;
  const call = <T>(action: string, args: unknown, timeoutMs = 25_000) =>
    wire.call<T>("places", action, args, { timeoutMs });

  useEffect(() => wire.subscribe("places"), [wire]);
  const machines = useStore(wire.store, (state) => machinesOf(state));
  const listed = useMemo(() => flowMachines(machines), [machines]);
  const recentAll = useStore(
    wire.store,
    (state) =>
      (state.targets.places?.sections.recent as RecentPlace[] | undefined) ??
      NONE,
  );
  const clones = useStore(
    wire.store,
    (state) =>
      (state.targets.places?.sections.clones as CloneView[] | undefined) ??
      NONE,
  );

  const [state, setState] = useState<FlowState>(() =>
    openFlow({ machines: listed }),
  );
  const update = (next: (now: FlowState) => FlowState) => setState(next);
  useEffect(() => {
    setState((now) => setMachines(now, listed));
  }, [listed]);

  const page = currentPage(state);
  const machineId = page.kind === "machine" ? undefined : page.machineId;
  const machine = machines.find((m) => m.id === machineId);

  const capabilities = useAnswer<PlaceCapabilities>(
    machineId === undefined
      ? undefined
      : () => call("capabilities", { machineId }, 40_000),
    `caps\0${machineId ?? ""}`,
  );
  const caps = capabilities.value;
  const flavor = caps?.flavor ?? (machine?.os === "win32" ? "win32" : "posix");
  const recent = recentAll.filter((place) => place.machineId === machineId);

  const settled = useSettled(page.query.trim());
  const searching =
    machineId !== undefined &&
    settled !== "" &&
    (page.kind === "search" ||
      page.kind === "new-parent" ||
      page.kind === "clone-location");
  const search = useAnswer<PlaceSearchResult>(
    searching ? () => call("search", { machineId, query: settled }) : undefined,
    `search\0${machineId ?? ""}\0${searching ? settled : ""}`,
  );
  const browsePath = page.kind === "browse" ? page.path : undefined;
  const listing = useAnswer<PlaceListing>(
    page.kind === "browse"
      ? () =>
          call("list", {
            machineId,
            ...(browsePath === null || browsePath === undefined
              ? {}
              : { path: browsePath }),
          })
      : undefined,
    `list\0${machineId ?? ""}\0${page.kind === "browse" ? (browsePath ?? "~") : ""}`,
  );
  // The last directory that could be listed: ← goes back to it from one that cannot be.
  const lastListedRef = useRef<PlaceListing | undefined>(undefined);
  if (listing.value !== undefined) lastListedRef.current = listing.value;
  const repos = useAnswer<ReposResult>(
    page.kind === "github" && caps?.gh === "ready"
      ? () => call("repos", { machineId, query: settled }, 40_000)
      : undefined,
    `repos\0${machineId ?? ""}\0${page.kind === "github" ? settled : ""}`,
  );

  const onChooseRef = useRef(options.onChoose);
  onChooseRef.current = options.onChoose;
  const cloneIdRef = useRef<string | undefined>(undefined);
  const clone = clones.find((each) => each.id === cloneIdRef.current);
  useEffect(() => {
    if (clone === undefined || clone.status === "running") return;
    cloneIdRef.current = undefined;
    if (clone.status === "done")
      onChooseRef.current({ machineId: clone.machineId, ...clone.target });
    else setState((now) => setError(now, clone.failure ?? { code: "other" }));
  }, [clone]);

  const fail = (error: unknown) =>
    setState((now) => setError(now, failureOf(error)));

  const open = (target: string, then?: (place: PlaceRef) => void) => {
    if (machineId === undefined) return;
    update((now) => setBusy(now, true));
    call<PlaceResolved>("resolve", { machineId, path: target }).then(
      (found) => {
        if (!found.exists) return fail(new Problem("not_found"));
        if (!found.directory) return fail(new Problem("not_directory"));
        update((now) => setBusy(now, false));
        const place = { path: found.path, display: found.display };
        if (then !== undefined) then(place);
        else onChooseRef.current({ machineId, ...place });
      },
      fail,
    );
  };

  const startClone = (repo: RepoChoice, parent: PlaceRef) => {
    if (machineId === undefined) return;
    update((now) => setBusy(now, true));
    call<{ clone: CloneView }>("clone", {
      machineId,
      url: repo.cloneUrl,
      ...(repo.protocol === undefined ? {} : { protocol: repo.protocol }),
      parent: parent.path,
    }).then((started) => {
      cloneIdRef.current = started.clone.id;
    }, fail);
  };

  const takeLocation = (place: PlaceRef) => {
    if (machineId === undefined) return;
    if (page.kind === "new-parent")
      update((now) => chooseNewParent(now, place));
    else if (page.kind === "clone-location") startClone(page.repo, place);
    else onChooseRef.current({ machineId, ...place });
  };

  const note = (value: MethodNote | undefined): string | undefined =>
    value === undefined ? undefined : t(NOTE_KEYS[value]);

  const rows: FlowRow[] = (() => {
    switch (page.kind) {
      case "machine":
        return machineOptions(state.machines, page.query).map(
          ({ machine: each, closed }) => ({
            key: each.id,
            label: each.name,
            ...(closed === undefined
              ? {}
              : { note: t(closed === "ssh" ? "closedSsh" : "closedOffline") }),
            disabled: closed !== undefined,
            take: () => update((now) => chooseMachine(now, each.id)),
          }),
        );
      case "method": {
        const needle = page.query.trim().toLowerCase();
        return methodOptions(caps)
          .map((option) => ({ option, label: t(WAY_KEYS[option.id]) }))
          .filter(({ label }) => label.toLowerCase().includes(needle))
          .map(({ option, label }) => {
            const why = note(option.note);
            return {
              key: option.id,
              label,
              ...(why === undefined ? {} : { note: why }),
              disabled: option.disabled,
              take: () =>
                update((now) => chooseMethod(now, page.machineId, option.id)),
            };
          });
      }
      case "search":
      case "new-parent":
      case "clone-location": {
        const parents: PlaceRef[] =
          caps === undefined
            ? []
            : page.kind === "clone-location"
              ? [caps.cloneParent]
              : page.kind === "new-parent"
                ? [{ path: caps.home, display: "~" }]
                : [];
        const name =
          page.kind === "clone-location"
            ? repoName(page.repo.nameWithOwner)
            : undefined;
        return buildSuggestions({
          query: page.query,
          flavor,
          os: machine?.os,
          recent:
            page.kind === "search"
              ? recent
              : [...parents, ...parentsOf(recent)],
          found:
            settled === page.query.trim() ? (search.value?.matches ?? []) : [],
        }).map((suggestion) => {
          if (suggestion.kind === "typed")
            return {
              key: `typed:${suggestion.path}`,
              label: t("openPath", { path: suggestion.path }),
              disabled: false,
              take: () =>
                open(
                  suggestion.path,
                  page.kind === "search" ? undefined : takeLocation,
                ),
            };
          const place = suggestion.place;
          const tags = [
            ...("git" in place && place.git === true ? [t("tagGit")] : []),
            ...("projectId" in place && place.projectId !== null
              ? [t("tagProject")]
              : []),
            ...(suggestion.kind === "recent" && page.kind === "search"
              ? [t("tagRecent")]
              : []),
          ];
          return {
            key: `${suggestion.kind}:${place.path}`,
            label:
              name === undefined
                ? place.display
                : childDisplay(place, name, flavor),
            ...(tags.length === 0 ? {} : { note: tags.join("  ") }),
            disabled: false,
            take: () =>
              takeLocation({ path: place.path, display: place.display }),
          };
        });
      }
      case "browse": {
        const at = listing.value;
        if (at === undefined) return [];
        const needle = page.query.trim().toLowerCase();
        return [
          {
            key: `here:${at.path}`,
            label: t("useDirectory"),
            note: at.display,
            disabled: false,
            take: () =>
              onChooseRef.current({
                machineId: page.machineId,
                path: at.path,
                display: at.display,
              }),
          },
          ...at.entries
            .filter(
              (entry) =>
                (page.showHidden || !entry.hidden) &&
                entry.name.toLowerCase().includes(needle),
            )
            .map((entry) => {
              const tags = [
                ...(entry.git ? [t("tagGit")] : []),
                ...(entry.projectId === null ? [] : [t("tagProject")]),
              ];
              return {
                key: entry.path,
                label: entry.name,
                ...(tags.length === 0 ? {} : { note: tags.join("  ") }),
                disabled: false,
                take: () =>
                  update((now) => openBrowse(now, page.machineId, entry.path)),
              };
            }),
        ];
      }
      case "github": {
        const found = repos.value?.available === true ? repos.value.repos : [];
        return repoOptions(manualRepoChoices(page.query), found).map(
          (repo) => ({
            key: repo.id,
            label: repo.nameWithOwner,
            ...(repo.protocol === undefined
              ? repo.description === null
                ? {}
                : { note: repo.description }
              : { note: t("via", { protocol: repo.protocol.toUpperCase() }) }),
            disabled: false,
            take: () => update((now) => chooseRepo(now, repo)),
          }),
        );
      }
      case "new-name": {
        const name = page.query.trim();
        if (name === "") return [];
        return [
          {
            key: `new:${name}`,
            label: t("createDir", {
              path: childDisplay(page.parent, name, flavor),
            }),
            disabled: false,
            take: () => {
              update((now) => setBusy(now, true));
              call<PlaceRef>("mkdir", {
                machineId: page.machineId,
                parent: page.parent.path,
                name,
              }).then((made) => {
                update((now) => setBusy(now, false));
                onChooseRef.current({ machineId: page.machineId, ...made });
              }, fail);
            },
          },
        ];
      }
    }
  })();

  const selectable = rows.map((row) => !row.disabled);
  const active = clampActive(page.activeIndex, selectable);

  /** What a key does; false when it is the caller's (Esc on the first page closes). */
  const key = (
    name: "up" | "down" | "enter" | "escape" | "tab" | "left",
  ): boolean => {
    if (name === "up" || name === "down") {
      update((now) =>
        moveActive(
          setActive(now, active),
          selectable,
          name === "down" ? "next" : "previous",
        ),
      );
      return true;
    }
    if (name === "enter") {
      if (page.busy) return true;
      const row = rows[active];
      if (row === undefined || row.disabled) return true;
      row.take();
      return true;
    }
    if (name === "tab") {
      if (page.kind === "browse")
        update((now) => setShowHidden(now, !page.showHidden));
      return true;
    }
    if (name === "left") {
      if (page.kind !== "browse" || page.query !== "") return true;
      const up =
        listing.value === undefined
          ? lastListedRef.current?.path
          : listing.value.parent?.path;
      if (up !== undefined)
        update((now) => openBrowse(now, page.machineId, up));
      return true;
    }
    if (cloneIdRef.current !== undefined) {
      void call("cancelClone", { cloneId: cloneIdRef.current });
      return true;
    }
    const previous = back(state);
    if (previous === null) return false;
    setState(previous);
    return true;
  };

  const problem: PlaceFailure | null =
    page.error ??
    (page.kind === "browse" && listing.error !== undefined
      ? failureOf(listing.error)
      : null) ??
    (page.kind === "method" && capabilities.error !== undefined
      ? failureOf(capabilities.error)
      : null);

  return {
    page,
    machine,
    rows,
    active,
    listing:
      page.kind === "browse"
        ? (listing.value ?? lastListedRef.current)
        : undefined,
    loading:
      (page.kind === "browse" && listing.pending) ||
      (searching && search.pending) ||
      (page.kind === "method" && capabilities.pending),
    problem,
    clone,
    flavor,
    type: (value: string) => update((now) => setQuery(now, value)),
    key,
  };
}

export type TuiPlaceFlow = ReturnType<typeof usePlaceFlow>;
